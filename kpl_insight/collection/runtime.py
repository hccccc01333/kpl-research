"""Small, dependency-free primitives shared by the collector and its watchdog."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from kpl_insight.paths import PROJECT_ROOT

ROOT = PROJECT_ROOT
RUNTIME = ROOT / "data" / "realtime" / "runtime"
SNAPSHOT_ROOT = ROOT / "data" / "realtime" / "raw_snapshots"
COLLECTOR_STATUS = RUNTIME / "collector_status.json"
LEASE = RUNTIME / "collector_lease.json"
PEER_STATUS = RUNTIME / "peer_status.json"

# os.replace is blocked by Windows while another process has the target open.
# Readers here are short-lived, so a few retries remove the whole class of
# "heartbeat vanished" false positives (2026-10-29 lost the first half of G2).
REPLACE_RETRIES = 6
REPLACE_BACKOFF_SEC = 0.1

# A live collector is considered stalled when its durable snapshot is older
# than this; the official feed advances roughly every 3-4 seconds.
SNAPSHOT_STALL_SEC = 60
HEARTBEAT_STALL_SEC = 90


def atomic_json(path: Path, payload: dict, retries: int = REPLACE_RETRIES) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    with staging.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    last_error: OSError | None = None
    for attempt in range(max(1, retries)):
        try:
            os.replace(staging, path)
            return
        except OSError as exc:  # WinError 5 / 32: reader or antivirus holds it briefly
            last_error = exc
            if attempt + 1 < retries:
                time.sleep(REPLACE_BACKOFF_SEC * (attempt + 1))
    try:
        staging.unlink()
    except OSError:
        pass
    assert last_error is not None
    raise last_error


def write_json_quiet(path: Path, payload: dict) -> bool:
    """Best-effort status write: never let telemetry take down acquisition."""
    try:
        atomic_json(path, payload)
        return True
    except Exception as exc:
        try:
            print(f"[WARN] status write failed ({path.name}): {exc}", flush=True)
        except Exception:
            pass
        return False


def read_json(path: Path) -> dict:
    try:
        # PowerShell 5.1 Set-Content -Encoding UTF8 writes a BOM; accept both.
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def age_seconds(value: str | None, now: datetime | None = None) -> float | None:
    try:
        return max(0.0, ((now or datetime.now()) - datetime.fromisoformat(value)).total_seconds())
    except (TypeError, ValueError):
        return None


def latest_snapshot_mtime(battle_id: str | None) -> float | None:
    """Newest durable raw snapshot for a battle (direct file stat, not status JSON)."""
    if not battle_id:
        return None
    directory = SNAPSHOT_ROOT / str(battle_id)
    newest: float | None = None
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                if not entry.name.endswith(".json"):
                    continue
                try:
                    mtime = entry.stat().st_mtime
                except OSError:
                    continue
                if newest is None or mtime > newest:
                    newest = mtime
    except OSError:
        return None
    return newest


def latest_snapshot_age(battle_id: str | None) -> float | None:
    mtime = latest_snapshot_mtime(battle_id)
    if mtime is None:
        return None
    return max(0.0, time.time() - mtime)


def pid_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        process_query_limited_information = 0x1000
        handle = kernel32.OpenProcess(process_query_limited_information, False, int(pid))
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def terminate_pid(pid: int | None, wait_sec: float = 4.0) -> bool:
    """Force-stop a hung peer so its file lock is released. Same-user, no elevation."""
    if not pid_alive(pid):
        return True
    assert pid is not None
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(int(pid)), "/T", "/F"],
                           capture_output=True, timeout=10, check=False)
            if pid_alive(pid):
                subprocess.run(["powershell", "-NoProfile", "-Command",
                                f"Stop-Process -Id {int(pid)} -Force -ErrorAction SilentlyContinue"],
                               capture_output=True, timeout=10, check=False)
        else:
            os.kill(int(pid), signal.SIGTERM)
    except Exception:
        pass
    deadline = time.time() + wait_sec
    while time.time() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.1)
    return not pid_alive(pid)


class ProcessLock:
    """OS releases this lock on exit/reboot; stale files do not block recovery."""

    def __init__(self, name: str):
        self.path = RUNTIME / f"{name}.lock"
        self.handle = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        if not self.path.stat().st_size:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        self.handle = handle
        return True

    def close(self) -> None:
        if self.handle is not None:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            self.handle.close()
            self.handle = None


LEADER_MUTEX_NAME = "Local\\KPLCollectorLeader"


class LeaderMutex:
    """Kernel-named liveness signal, immune to antivirus/file-lock stalls.

    The leader holds a named mutex for its whole lifetime. A standby checks
    OpenMutex instead of trusting JSON file ages; when the process exits the OS
    destroys the object, so takeover is immediate and cannot be faked by a
    transient WinError 5 on the lease/status files.
    """

    def __init__(self, name: str = LEADER_MUTEX_NAME):
        self.name = name
        self.handle = None
        self.kernel = None
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        kernel.CreateMutexW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel = kernel
        self.handle = kernel.CreateMutexW(None, False, name)

    def close(self) -> None:
        if self.handle and self.kernel is not None:
            self.kernel.CloseHandle(self.handle)
            self.handle = None

    @staticmethod
    def is_held(name: str = LEADER_MUTEX_NAME) -> bool:
        if os.name != "nt":
            return False
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenMutexW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
        kernel.OpenMutexW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenMutexW(0x00100000, False, name)  # SYNCHRONIZE
        if not handle:
            return False
        kernel.CloseHandle(handle)
        return True


class ChildProcessJob:
    """Windows kills collector + its subprocesses if the supervisor disappears."""

    def __init__(self):
        self.handle = None
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                        ("flags", wintypes.DWORD), ("min_ws", ctypes.c_size_t),
                        ("max_ws", ctypes.c_size_t), ("active_processes", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                        ("scheduling", wintypes.DWORD)]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("basic", BasicLimits), ("io_counters", ctypes.c_uint64 * 6),
                        ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                        ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.CreateJobObjectW(None, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.get_last_error()
            kernel.CloseHandle(handle)
            raise ctypes.WinError(error)
        self.kernel = kernel
        self.handle = handle

    def attach(self, proc) -> None:
        if self.handle is not None and not self.kernel.AssignProcessToJobObject(self.handle, int(proc._handle)):
            import ctypes
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        if self.handle is not None:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def snapshot_age_for(status: dict, now: datetime | None = None) -> float | None:
    battle_id = status.get("battle_id")
    if not battle_id:
        return None
    mtime = latest_snapshot_mtime(str(battle_id))
    if mtime is None:
        return None
    return max(0.0, (now or datetime.now()).timestamp() - mtime)


def collector_health(status: dict, now: datetime | None = None) -> dict:
    """Heartbeat and durable-data progress are deliberately separate signals.

    Heartbeat = process is alive. Snapshot age = the crawl is actually saving
    frames. 2026-10-29: the heartbeat write raced a reader, the collector was
    killed as "dead", and the first half of G2 was lost. Health now looks at
    the raw snapshot directory on disk, so a telemetry hiccup cannot mask (or
    fake) acquisition progress.
    """
    heartbeat_age = age_seconds(status.get("updated_at"), now)
    saved_age = age_seconds(status.get("last_saved_at"), now)
    snapshot_age = snapshot_age_for(status, now)
    poll_age = age_seconds(status.get("last_poll_at"), now)
    issues = []
    if heartbeat_age is None or heartbeat_age > 180:
        issues.append("heartbeat_missing_or_stale")
    if status.get("state") in {"error", "api_error", "stopped"}:
        issues.append("collector_error")
    if status.get("source_status") == 1 and (saved_age is None or saved_age > 90):
        issues.append("no_durable_snapshot_90s")
    if (status.get("source_status") == 1 and status.get("battle_id")
            and (snapshot_age is None or snapshot_age > SNAPSHOT_STALL_SEC)
            and poll_age is not None and poll_age > HEARTBEAT_STALL_SEC):
        issues.append("no_fresh_snapshot_30s")
    progress_age = age_seconds(status.get("source_advanced_at"), now)
    if status.get("source_status") == 1 and progress_age is not None and progress_age > 120:
        issues.append("source_clock_not_advancing_120s")
    return {"healthy": not issues, "issues": issues, "heartbeat_age_sec": heartbeat_age,
            "saved_age_sec": saved_age, "snapshot_age_sec": snapshot_age,
            "poll_age_sec": poll_age,
            "source_progress_age_sec": progress_age,
            "battle_id": status.get("battle_id"), "state": status.get("state")}

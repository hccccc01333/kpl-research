"""
KPL 官方赛程自动监控与实时采集脚本

能力：
- 自动从官方赛程接口识别进行中或最近一场比赛；
- 自动发现当前 battle_id；
- 多副本探测获取最新局内数据；
- 爬虫与模型并行：采集线程高频写 raw/frames，推理线程异步写 predictions；
- 保存 raw snapshots、frames CSV、实时预测 CSV、monitor_status.json；
- 一场 BO 全部结束后，等待下一场开赛时间并自动切换预测；
- 当日全部比赛结束后统一重训一次模型，并热加载新模型（非每场/每局都训练）。

运行示例：
    python -m kpl_insight.collection.monitor --interval 0.1
    python -m kpl_insight.collection.monitor --no-auto-train
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

from kpl_insight.core import (
    LEAGUE_ID,
    REWIND_ACCEPT_TOLERANCE_SEC,
    PREDICTION_CSV_FIELDS,
    PREDICTION_DIR,
    RAW_DIR,
    REALTIME_DIR,
    ScheduleCenter,
    ScheduleMatch,
    adaptive_poll_interval,
    compute_lag_sec,
    fetch_freshest_battle,
    is_monotonic_snapshot,
    load_model,
    parse_snapshot,
    predict_probability,
    refresh_schedule_archive,
    sanitize_lag_sec,
)
from kpl_insight.models.train import train_v9_model
from kpl_insight.collection.runtime import (
    COLLECTOR_STATUS,
    HEARTBEAT_STALL_SEC,
    LEASE,
    LeaderMutex,
    ProcessLock,
    RUNTIME,
    age_seconds,
    atomic_json,
    latest_snapshot_age,
    pid_alive,
    read_json,
    terminate_pid,
    write_json_quiet,
)


STATUS_FILE = REALTIME_DIR / "monitor_status.json"
TRAIN_STATUS_FILE = REALTIME_DIR / "train_status.json"
FRAME_DIR = REALTIME_DIR / "frames"
ERROR_LOG = RUNTIME / "collector_errors.jsonl"
SHADOW_DIR = REALTIME_DIR / "raw_snapshots_shadow"
LEASE_INTERVAL_SEC = 2.0
LEASE_STALE_SEC = 8.0
HEARTBEAT_INTERVAL_SEC = 2.0
FOLLOWER_STALE_SEC = 12.0
FOLLOWER_KILL_AFTER_SEC = 12.0
PEER_STATUS_INTERVAL_SEC = 2.0
FRAME_CSV_FIELDS = [
    "collected_at",
    "match_id",
    "battle_id",
    "minute",
    "snapshot_time_sec",
    "lag_sec",
    "camp1_team",
    "camp2_team",
    "gold_diff",
    "kill_diff",
    "tower_diff",
    "status",
    "win_camp",
    # 新增列只在新建文件时写表头；旧文件保留旧表头，多余的列被忽略。
    "missing_camp_fields",
    "team_name_fallback",
]
_SAVE_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="kpl-save")
_TRAIN_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kpl-train")
_SENTINEL = object()
_COLLECTOR_STATUS: dict[str, Any] = {}
_LAST_HEARTBEAT_WRITE = 0.0
_STATUS_WRITE_LOCK = threading.Lock()
_HEARTBEAT_LOCK = threading.Lock()
_ERROR_LOCK = threading.Lock()
_LAST_ERROR_PRINT = 0.0
_LAST_STALE_RETRY = 0.0
_HEALTH_PORT = 0
_PROCESS_START = time.time()
_LAST_SHADOW_POLL = 0.0
_LAST_SHADOW_DIGEST: dict[str, str] = {}


def _note_error(kind: str, exc: BaseException) -> None:
    """Log a non-fatal write/cycle failure without ever touching status files.

    2026-10-29: the exception handler called write_status(), which used the same
    os.replace that had just failed, killing the collector. Errors must never be
    able to escalate into the failure path itself.
    """
    global _LAST_ERROR_PRINT
    now_mono = time.monotonic()
    if now_mono - _LAST_ERROR_PRINT >= 15:
        _LAST_ERROR_PRINT = now_mono
        try:
            print(f"[WARN] {kind}: {exc}", flush=True)
        except Exception:
            pass
    try:
        with _ERROR_LOCK:
            with ERROR_LOG.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"at": datetime.now().isoformat(),
                                         "kind": kind, "error": str(exc)},
                                        ensure_ascii=False) + "\n")
    except Exception:
        pass


def _write_heartbeat(force: bool = False) -> None:
    global _LAST_HEARTBEAT_WRITE
    now_mono = time.monotonic()
    if not force and now_mono - _LAST_HEARTBEAT_WRITE < 5:
        return
    _LAST_HEARTBEAT_WRITE = now_mono
    payload = {**_COLLECTOR_STATUS, "pid": os.getpid(),
               "updated_at": datetime.now().isoformat(timespec="seconds")}
    try:
        with _HEARTBEAT_LOCK:
            atomic_json(COLLECTOR_STATUS, payload)
    except Exception as exc:
        _note_error("heartbeat_write", exc)


def collector_heartbeat(**fields) -> None:
    """Only the crawl thread owns the fields; the heartbeat thread owns liveness."""
    _COLLECTOR_STATUS.update(fields)
    _write_heartbeat()


def heartbeat_worker(ctx: "PipelineContext") -> None:
    """Keep process liveness fresh even while the crawl loop waits between games.

    Progress is judged separately from the raw snapshot mtime, so this thread
    cannot mask a hung crawl.
    """
    while not ctx.stop_event.wait(HEARTBEAT_INTERVAL_SEC):
        _write_heartbeat(force=True)


def lease_worker(ctx: "PipelineContext") -> None:
    """Publish battle context for the warm standby (liveness is the heartbeat)."""
    while not ctx.stop_event.wait(LEASE_INTERVAL_SEC):
        payload = {
            "pid": os.getpid(),
            "role": ctx.role,
            "state": _COLLECTOR_STATUS.get("state"),
            "match_id": _COLLECTOR_STATUS.get("match_id"),
            "battle_id": _COLLECTOR_STATUS.get("battle_id"),
            "source_time_sec": _COLLECTOR_STATUS.get("source_time_sec"),
            "heartbeat_at": _COLLECTOR_STATUS.get("updated_at"),
            "health_port": _HEALTH_PORT,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
            "epoch": round(time.time(), 3),
        }
        try:
            with _HEARTBEAT_LOCK:
                atomic_json(LEASE, payload)
        except Exception as exc:
            _note_error("lease_write", exc)


def health_server(ctx: "PipelineContext") -> None:
    """Loopback liveness/progress channel, independent of status-file locks.

    The status/lease JSON files can be held by antivirus for tens of seconds;
    that used to look like a hung process. This socket answers with the
    in-memory poll epoch, so the standby can distinguish "file is locked" from
    "process/crawl is actually stuck" without touching disk.
    """
    global _HEALTH_PORT
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind(("127.0.0.1", 0))
        server.listen(8)
        server.settimeout(0.5)
        _HEALTH_PORT = server.getsockname()[1]
    except OSError as exc:
        _note_error("health_server", exc)
        try:
            server.close()
        except OSError:
            pass
        return
    while not ctx.stop_event.is_set():
        try:
            conn, _ = server.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        try:
            conn.settimeout(1.0)
            request = conn.recv(64)
            if request.strip().upper() == b"PING":
                payload = {
                    "pid": os.getpid(),
                    "started_epoch": _PROCESS_START,
                    "state": _COLLECTOR_STATUS.get("state"),
                    "match_id": _COLLECTOR_STATUS.get("match_id"),
                    "match": _COLLECTOR_STATUS.get("match"),
                    "battle_id": _COLLECTOR_STATUS.get("battle_id"),
                    "source_time_sec": _COLLECTOR_STATUS.get("source_time_sec"),
                    "last_poll_epoch": _COLLECTOR_STATUS.get("last_poll_epoch"),
                    "updated_at": _COLLECTOR_STATUS.get("updated_at"),
                }
                conn.sendall(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass
    try:
        server.close()
    except OSError:
        pass


def _ping_health(port: int, timeout: float = 0.8) -> dict | None:
    if not port:
        return None
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout) as sock:
            sock.sendall(b"PING\n")
            sock.settimeout(timeout)
            data = sock.recv(512)
        payload = json.loads(data.decode("utf-8") or "{}")
        return payload if isinstance(payload, dict) else None
    except (OSError, ValueError):
        return None


@dataclass
class CollectedFrame:
    match_id: str
    battle_id: str
    match_name: str
    collected_at: str
    raw: dict[str, Any]
    snap: dict[str, Any]
    lag_sec: float | None
    clock_jump: bool


@dataclass
class PipelineContext:
    artifact: dict
    auto_train: bool = True
    train_after_matches: int = 0
    trained_session: bool = False
    training: bool = False
    last_data_sig: tuple[int, float] | None = None
    battle_anchors: dict[str, tuple[datetime, int]] = field(default_factory=dict)
    last_velocity_by_battle: dict[str, float] = field(default_factory=dict)
    last_snapshot_sec: dict[str, int] = field(default_factory=dict)
    last_source_advance: dict[str, float] = field(default_factory=dict)
    last_frame_key: dict[str, tuple] = field(default_factory=dict)
    last_raw_digest: dict[str, str] = field(default_factory=dict)
    last_lag_sec: dict[str, float] = field(default_factory=dict)
    # Match API sometimes drops active battle_id mid-game; keep polling last known id.
    sticky_battle_by_match: dict[str, str] = field(default_factory=dict)
    frame_queue: queue.Queue = field(default_factory=lambda: queue.Queue(maxsize=800))
    # Deduped timeline: battle_id -> snapshot_time_sec -> latest unique frame.
    deduped_timeline: dict[str, dict[int, CollectedFrame]] = field(default_factory=dict)
    predicted_secs: dict[str, set[int]] = field(default_factory=dict)
    predict_history: dict[str, list[dict]] = field(default_factory=dict)
    collect_history: dict[str, list[dict]] = field(default_factory=dict)
    stop_event: threading.Event = field(default_factory=threading.Event)
    collect_interval_sec: float = 0.1
    last_battle_resolve_at: float = 0.0
    model_state: str = "loading"
    role: str = "primary"
    coverage_done: set[str] = field(default_factory=set)
    finished_battles: set[str] = field(default_factory=set)
    replayed_battles: set[str] = field(default_factory=set)
    _status_lock: threading.Lock = field(default_factory=threading.Lock)
    _timeline_lock: threading.Lock = field(default_factory=threading.Lock)


def write_status(payload: dict, ctx: PipelineContext | None = None):
    if threading.current_thread() is threading.main_thread():
        if payload.get("state") in {"waiting_start", "waiting_schedule", "waiting_battle", "day_complete", "waiting_next_match"}:
            _COLLECTOR_STATUS["source_status"] = 0
        _COLLECTOR_STATUS["last_poll_epoch"] = time.time()
        collector_heartbeat(**payload)
    payload = {"updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), **payload}
    with _STATUS_WRITE_LOCK:
        # Telemetry must never be able to crash or block acquisition.
        write_json_quiet(STATUS_FILE, payload)


def _mark_waiting(state: str = "waiting_battle") -> None:
    """Clear the finished battle so the freshness watchdog cannot mistake the
    inter-game wait for a 9-minute crawl stall (2026-10-30 19:56 false kill)."""
    _COLLECTOR_STATUS.update(state=state, battle_id=None, source_status=0,
                             source_time_sec=None, last_poll_at=None)
    _write_heartbeat(force=True)


def save_raw_snapshot(battle_id: str, payload: dict) -> Path:
    out_dir = RAW_DIR / battle_id
    out_dir.mkdir(parents=True, exist_ok=True)
    # Microseconds: 0.1s crawl would collide on second-only names.
    path = out_dir / f"{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.json"
    with path.open("x", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    return path


def save_raw_snapshot_async(battle_id: str, payload: dict) -> None:
    _SAVE_EXECUTOR.submit(save_raw_snapshot, battle_id, payload)


def save_shadow_snapshot(battle_id: str, payload: dict) -> Path | None:
    """Standby-side raw archive; only on content change (bounded disk use)."""
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None
    digest = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False)
                            .encode("utf-8")).hexdigest()
    if _LAST_SHADOW_DIGEST.get(battle_id) == digest:
        return None
    _LAST_SHADOW_DIGEST[battle_id] = digest
    out_dir = SHADOW_DIR / battle_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{datetime.now():%Y%m%d_%H%M%S_%f}_{os.getpid()}.json"
    with path.open("x", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    return path


def shadow_poll(lease: dict, status: dict) -> None:
    """The standby keeps polling a live battle so a failover has no data hole."""
    global _LAST_SHADOW_POLL
    now = time.monotonic()
    if now - _LAST_SHADOW_POLL < 1.0:
        return
    _LAST_SHADOW_POLL = now
    battle_id = str(lease.get("battle_id") or status.get("battle_id") or "")
    state = str(status.get("state") or lease.get("state") or "")
    if not battle_id or (state not in {"live", "polling"} and status.get("source_status") != 1):
        return
    try:
        raw = fetch_freshest_battle(battle_id, n_probes=2, gap_sec=0.1, min_game_sec=0)
        if raw:
            save_shadow_snapshot(battle_id, raw)
    except Exception as exc:
        _note_error("shadow_poll", exc)


def cleanup_shadow(max_age_sec: int = 3 * 86400) -> None:
    try:
        now = time.time()
        with os.scandir(SHADOW_DIR) as entries:
            for entry in entries:
                try:
                    if entry.is_dir() and now - entry.stat().st_mtime > max_age_sec:
                        shutil.rmtree(entry.path, ignore_errors=True)
                except OSError:
                    continue
    except OSError:
        pass


def replay_gap(ctx: "PipelineContext", match_id: str, battle_id: str, match_name: str) -> int:
    """Rebuild frames/predictions for a failover gap from durable raw snapshots.

    The old leader's raw files and the standby's shadow files both contain the
    full snapshot (all fields, not just gold). Any frame missing between the
    last CSV row and the new leader's first poll is replayed here.
    """
    last_sec = 0
    last_ts = 0.0
    frame_path = FRAME_DIR / f"{battle_id}.csv"
    try:
        with frame_path.open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        if rows:
            last_sec = int(float(rows[-1].get("snapshot_time_sec") or 0))
            last_ts = datetime.fromisoformat(rows[-1].get("collected_at")).timestamp()
    except (OSError, ValueError):
        pass
    candidates = []
    for root in (RAW_DIR, SHADOW_DIR):
        directory = root / battle_id
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    if not entry.name.endswith(".json"):
                        continue
                    try:
                        mtime = entry.stat().st_mtime
                    except OSError:
                        continue
                    if last_ts and mtime < last_ts - 2:
                        continue
                    candidates.append((mtime, entry.path))
        except OSError:
            continue
    candidates.sort()
    seen = set()
    added = 0
    for mtime, path in candidates[-600:]:
        try:
            payload = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            continue
        snap = parse_snapshot(data, battle_id)
        sec = int(snap.get("time_sec", 0) or snap.get("snapshot_time_sec", 0) or 0)
        if sec <= last_sec:
            continue
        key = frame_dedupe_key(snap)
        if key in seen:
            continue
        seen.add(key)
        collected_at = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        row = {
            "collected_at": collected_at,
            "match_id": match_id,
            "battle_id": battle_id,
            "minute": round(float(snap.get("minute", 0)), 2),
            "snapshot_time_sec": sec,
            "lag_sec": "",
            "camp1_team": snap.get("camp1_team"),
            "camp2_team": snap.get("camp2_team"),
            "gold_diff": snap.get("camp1_gold", 0) - snap.get("camp2_gold", 0),
            "kill_diff": snap.get("camp1_kill", 0) - snap.get("camp2_kill", 0),
            "tower_diff": snap.get("camp1_tower", 0) - snap.get("camp2_tower", 0),
            "status": snap.get("status"),
            "win_camp": snap.get("win_camp"),
            "missing_camp_fields": snap.get("missing_camp_fields", ""),
            "team_name_fallback": snap.get("team_name_fallback", 0),
        }
        # 写盘去重（接管/重启后盘面已有的帧不再追加），
        # 但预测仍然入队：帧在而预测缺的局要靠这里补齐，预测写盘自身也有去重。
        if append_frame(battle_id, row):
            added += 1
        if ctx.model_state != "disabled":
            enqueue_frame(ctx, CollectedFrame(match_id=match_id, battle_id=battle_id,
                                              match_name=match_name, collected_at=collected_at,
                                              raw=payload, snap=snap, lag_sec=None,
                                              clock_jump=False))
        ctx.last_snapshot_sec[battle_id] = sec
        ctx.last_frame_key[battle_id] = key
        last_sec = sec
    if added:
        print(f"[REPLAY] {battle_id} 从原始/影子快照补回 {added} 帧（接管缺口）")
    return added


def _append_csv(path: Path, fields: list[str], row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    exists = path.exists()
    use_fields = list(fields)
    if exists:
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            header = next(csv.reader(f), None)
        if header:
            use_fields = header
    full_row = {col: row.get(col, "") for col in use_fields}
    with path.open("a", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=use_fields, extrasaction="ignore")
        if not exists:
            writer.writeheader()
        writer.writerow(full_row)


_FRAME_KEYS: dict[str, set[tuple]] = {}
_PREDICTION_KEYS: dict[str, set[tuple]] = {}


def _cell(value) -> str:
    """CSV 单元格归一化。注意 0 不能变成空串——胜方/状态经常就是 0。"""
    return "" if value is None else str(value)


def _csv_keys(path: Path, fields: tuple[str, ...]) -> set[tuple]:
    """把已有 CSV 里的行读成去重键，用磁盘内容做去重基线。

    主备接管时进程内的 last_frame_key / predicted_secs 都是空的，
    于是整段历史会被重新追加一遍——实测最坏一局 261 行里 207 行完全重复。
    以磁盘为准，重启、接管、回补都不会再制造重复行。
    """
    keys: set[tuple] = set()
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                keys.add(tuple(_cell(row.get(field)) for field in fields))
    except OSError:
        pass
    return keys


def _row_key(row: dict, fields: tuple[str, ...]) -> tuple:
    return tuple(_cell(row.get(field)) for field in fields)


_FRAME_KEY_FIELDS = ("snapshot_time_sec", "gold_diff", "kill_diff", "tower_diff",
                     "status", "win_camp")
_PREDICTION_KEY_FIELDS = ("snapshot_time_sec", "camp1_win_prob", "status", "win_camp")


def _append_once(path: Path, fields: list[str], row: dict, cache: dict[str, set[tuple]],
                 key_fields: tuple[str, ...], key: str) -> bool:
    seen = cache.get(key)
    if seen is None:
        seen = _csv_keys(path, key_fields)
        cache[key] = seen
    ident = _row_key(row, key_fields)
    if ident in seen:
        return False
    seen.add(ident)
    _append_csv(path, fields, row)
    return True


def append_prediction(battle_id: str, row: dict) -> bool:
    return _append_once(PREDICTION_DIR / f"{battle_id}.csv", list(PREDICTION_CSV_FIELDS), row,
                        _PREDICTION_KEYS, _PREDICTION_KEY_FIELDS, battle_id)


def append_frame(battle_id: str, row: dict) -> bool:
    """Crawl-only timeline (no model). 同一秒同一盘面只写一次。"""
    return _append_once(FRAME_DIR / f"{battle_id}.csv", FRAME_CSV_FIELDS, row,
                        _FRAME_KEYS, _FRAME_KEY_FIELDS, battle_id)


def frame_dedupe_key(snap: dict[str, Any]) -> tuple:
    """Identity of a crawl row: same game clock + board state => duplicate."""
    sec = int(snap.get("time_sec", 0) or snap.get("snapshot_time_sec", 0) or 0)
    return (
        sec,
        int(snap.get("camp1_gold", 0) or 0),
        int(snap.get("camp2_gold", 0) or 0),
        int(snap.get("camp1_kill", 0) or 0),
        int(snap.get("camp2_kill", 0) or 0),
        int(snap.get("camp1_tower", 0) or 0),
        int(snap.get("camp2_tower", 0) or 0),
        int(snap.get("status", 0) or 0),
        int(snap.get("win_camp", 0) or 0),
    )


def next_poll_interval(ctx: PipelineContext, battle_id: str | None, args) -> float:
    if not getattr(args, "adaptive", False) or not battle_id:
        return float(args.interval)
    velocity = ctx.last_velocity_by_battle.get(battle_id, 0.0)
    return float(
        adaptive_poll_interval(
            velocity,
            interval_calm=float(args.interval),
            interval_hot=float(args.interval_hot),
            hot_velocity_threshold=args.hot_velocity,
        )
    )


def ensure_battle_anchor(ctx: PipelineContext, battle_id: str, snap: dict) -> None:
    if battle_id in ctx.battle_anchors:
        return
    game_sec = int(snap.get("time_sec", 0) or snap.get("snapshot_time_sec", 0) or 0)
    if game_sec > 0:
        ctx.battle_anchors[battle_id] = (datetime.now(), game_sec)


def realtime_data_signature() -> tuple[int, float]:
    """Cheap signature: battle-dir count + newest mtime (no full JSON glob)."""
    if not RAW_DIR.exists():
        return 0, 0.0
    dirs = [p for p in RAW_DIR.iterdir() if p.is_dir()]
    if not dirs:
        return 0, 0.0
    latest = 0.0
    for d in dirs:
        try:
            mt = d.stat().st_mtime
            if mt > latest:
                latest = mt
            for child in d.iterdir():
                if child.suffix == ".json":
                    try:
                        cmt = child.stat().st_mtime
                        if cmt > latest:
                            latest = cmt
                            break  # one file peek is enough for "data changed" signal
                    except OSError:
                        continue
        except OSError:
            continue
    return len(dirs), latest


def write_train_status(payload: dict):
    TRAIN_STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {"updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), **payload}
    TRAIN_STATUS_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def recover_stale_train_status():
    """监控进程重启会杀死后台训练线程；启动时把残留的 training 落成 error。

    2026-10-20 20:45 触发重训，20:58 监控被重启，训练线程随之被杀，但状态文件
    一直停在 training。这里在启动时显式收尾，下一比赛日会重新触发。
    """
    try:
        cur = json.loads(TRAIN_STATUS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return
    if str(cur.get("state")) != "training":
        return
    write_train_status(
        {
            "state": "error",
            "reason": str(cur.get("reason") or "interrupted"),
            "finished_matches": cur.get("finished_matches"),
            "needed_matches": cur.get("needed_matches"),
            "snapshot_dirs": cur.get("snapshot_dirs"),
            "message": "上次重训未完成（监控进程已重启），将在下一比赛日后重试",
        }
    )
    print("[TRAIN] 检测到上次重训被中断，状态已重置为 error；下一比赛日后会重试")


def today_match_progress(schedule: ScheduleCenter, date: str | None = None) -> tuple[int, int, list[ScheduleMatch]]:
    """Return finished_count, total_count, today's matches."""
    if date:
        today = [
            m for m in schedule.fetch_matches()
            if m.start_time and m.start_time.strftime("%Y-%m-%d") == date
        ]
    else:
        today = schedule.today_matches()
    finished = [m for m in today if m.status == 2]
    return len(finished), len(today), today


def matches_needed_for_train(schedule: ScheduleCenter, date: str | None, train_after_matches: int) -> int:
    _, total, _ = today_match_progress(schedule, date)
    if train_after_matches > 0:
        return min(train_after_matches, total) if total else train_after_matches
    return total if total else 3


def _train_job(ctx: PipelineContext, reason: str, finished_count: int, needed: int, sig: tuple[int, float]) -> None:
    try:
        artifact = train_v9_model(verbose=False)
        ctx.artifact = artifact
        ctx.last_data_sig = sig
        ctx.trained_session = True
        metrics = (
            artifact.get("metrics", {}).get("VotingMidlate")
            or artifact.get("metrics", {}).get("VotingV9")
            or {}
        )
        holdout = artifact.get("holdout_real", {}).get("all", {})
        write_train_status(
            {
                "state": "ready",
                "reason": reason,
                "finished_matches": finished_count,
                "needed_matches": needed,
                "snapshot_dirs": sig[0],
                "real_rows": artifact.get("real_rows", 0),
                "sim_rows": artifact.get("sim_rows", 0),
                "model_name": artifact.get("model_name", "Unknown"),
                "version": artifact.get("version", "V9"),
                "trained_at": artifact.get("trained_at", ""),
                "auc": metrics.get("auc"),
                "accuracy": metrics.get("accuracy"),
                "holdout_real_brier": holdout.get("brier"),
                "holdout_real_ece": holdout.get("ece"),
                "holdout_early_brier": artifact.get("holdout_real", {}).get("early", {}).get("brier"),
                "holdout_mid_brier": artifact.get("holdout_real", {}).get("mid", {}).get("brier"),
                "holdout_late_brier": artifact.get("holdout_real", {}).get("late", {}).get("brier"),
                "comeback_acc": artifact.get("holdout_comeback", {}).get("all", {}).get("accuracy"),
                "use_time_shrinkage": artifact.get("use_time_shrinkage"),
                "calibrator": "phase_isotonic" if artifact.get("calibrator_early") is not None else (
                    "isotonic" if artifact.get("calibrator") is not None else "none"
                ),
            }
        )
        write_status(
            {
                "state": "day_complete",
                "message": (
                    f"重训完成 holdout_brier={holdout.get('brier', float('nan')):.4f} "
                    f"(mixed AUC={metrics.get('auc', 0):.3f} 仅供参考)"
                ),
                "model_name": artifact.get("model_name", "Unknown"),
            }
        )
        print(
            f"[TRAIN] 完成 holdout_brier={holdout.get('brier', float('nan')):.4f} "
            f"mixed_auc={metrics.get('auc', 0):.3f} "
            f"real={artifact.get('real_rows', 0)} sim={artifact.get('sim_rows', 0)}"
        )
    except Exception as exc:
        write_train_status({"state": "error", "reason": reason, "message": str(exc)})
        write_status({"state": "train_error", "message": f"重训失败: {exc}"})
        print(f"[TRAIN] 失败: {exc}")
    finally:
        ctx.training = False


def try_retrain_once(ctx: PipelineContext, schedule: ScheduleCenter, date: str | None, reason: str) -> bool:
    """当日比赛打满后异步重训一次；主循环不阻塞采集。"""
    if not ctx.auto_train or ctx.training or ctx.trained_session:
        return False

    finished_count, total_count, _ = today_match_progress(schedule, date)
    needed = matches_needed_for_train(schedule, date, ctx.train_after_matches)
    if finished_count < needed:
        print(f"[TRAIN] 今日已完成 {finished_count}/{needed} 场，暂不训练")
        return False

    sig = realtime_data_signature()
    if sig[0] == 0:
        return False

    ctx.training = True
    write_status({"state": "training", "message": f"今日 {finished_count} 场比赛已结束，后台重训中（采集不中断）"})
    write_train_status(
        {
            "state": "training",
            "reason": reason,
            "finished_matches": finished_count,
            "needed_matches": needed,
            "snapshot_dirs": sig[0],
        }
    )
    print(f"[TRAIN] 后台启动 · 今日 {finished_count}/{needed} 场已结束 · dirs={sig[0]}")
    _TRAIN_EXECUTOR.submit(_train_job, ctx, reason, finished_count, needed, sig)
    return True


def maybe_train_after_batch(
    ctx: PipelineContext,
    schedule: ScheduleCenter,
    date: str | None,
    reason: str,
) -> None:
    finished_count, total_count, _ = today_match_progress(schedule, date)
    needed = matches_needed_for_train(schedule, date, ctx.train_after_matches)
    if finished_count >= needed:
        try_retrain_once(ctx, schedule, date, reason)


def seconds_until(start_time: datetime) -> int:
    return max(0, int((start_time - datetime.now()).total_seconds()))


def _find_better_match(schedule: ScheduleCenter, current: ScheduleMatch) -> ScheduleMatch | None:
    """找比 current 更该监控的场次：进行中优先，其次是新发布的更早待赛场次。

    2026-10-29 事故：monitor 在 10-28 完赛后锁定了 11-01 的待定场次；官方随后
    补发 10-29 / 10-30 赛程，但旧逻辑只检查 status=1，于是一直等到 11-01，
    导致 10-29 整场没有采集。这里每 30 秒同时检查更早的待赛场次。
    """
    try:
        matches = schedule.fetch_matches()
    except Exception:
        return None
    active = [
        m for m in matches
        if m.status == 1 and m.match_id != current.match_id
    ]
    if active:
        return sorted(active, key=lambda m: m.start_time or datetime.max)[0]
    if not current.start_time:
        return None
    now = datetime.now()
    earlier = [
        m for m in matches
        if m.match_id != current.match_id
        and m.status == 0
        and m.start_time
        and m.start_time >= now - timedelta(minutes=30)
        and m.start_time < current.start_time
    ]
    if earlier:
        return sorted(earlier, key=lambda m: m.start_time or datetime.max)[0]
    return None


def wait_until_start(
    match: ScheduleMatch,
    poll_sec: int,
    ctx: PipelineContext,
    label: str = "waiting_start",
    schedule: ScheduleCenter | None = None,
):
    if not match.start_time:
        return None
    last_print = 0.0
    last_active_check = 0.0
    last_schedule_refresh = time.monotonic()
    while True:
        wait_sec = seconds_until(match.start_time)
        if wait_sec <= 0:
            return None
        # 空窗期也要刷新赛程归档：新场次可能在等待期间发布，站点 data.js 依赖它。
        if time.monotonic() - last_schedule_refresh >= 1800:
            last_schedule_refresh = time.monotonic()
            try:
                n = refresh_schedule_archive()
                print(f"[SCHED] 空窗期刷新赛程缓存 {n} 场")
            except Exception as exc:
                print(f"[WARN] 空窗期赛程刷新失败: {exc}")
        if schedule is not None and time.monotonic() - last_active_check >= 30:
            last_active_check = time.monotonic()
            better = _find_better_match(schedule, match)
            if better and better.match_id != match.match_id:
                print(f"[SWITCH] 发现更该监控的比赛 {better.display_name}，切换监控")
                return better
        write_status(
            {
                "state": label,
                "match_id": match.match_id,
                "match": match.display_name,
                "team1": match.team1,
                "team2": match.team2,
                "start_time": match.start_time.strftime("%Y-%m-%d %H:%M:%S"),
                "seconds_until_start": wait_sec,
                "model_name": ctx.artifact.get("model_name", "Unknown"),
                "message": f"等待开赛，距离开赛还有 {wait_sec // 60} 分 {wait_sec % 60} 秒",
            }
        )
        now_mono = time.monotonic()
        if wait_sec > 600 and now_mono - last_print >= 300:
            print(
                f"[WAIT] {match.team1} vs {match.team2} "
                f"开赛倒计时 {wait_sec // 60:02d}:{wait_sec % 60:02d}"
            )
            last_print = now_mono
        elif wait_sec <= 600 and now_mono - last_print >= 60:
            print(
                f"[WAIT] {match.team1} vs {match.team2} "
                f"开赛倒计时 {wait_sec // 60:02d}:{wait_sec % 60:02d}"
            )
            last_print = now_mono
        # Keep the status/heartbeat at 5s even while waiting: the standby uses
        # heartbeat age to decide whether the leader is alive.
        time.sleep(min(5, poll_sec, wait_sec))


def clear_battle_runtime(ctx: PipelineContext, match_id: str, battle_id: str) -> None:
    """Drop crawl-side state; predict history is cleared after finishing PRED."""
    ctx.collect_history.pop(battle_id, None)
    ctx.last_snapshot_sec.pop(battle_id, None)
    ctx.last_frame_key.pop(battle_id, None)
    if ctx.sticky_battle_by_match.get(match_id) == battle_id:
        ctx.sticky_battle_by_match.pop(match_id, None)


def enqueue_frame(ctx: PipelineContext, frame: CollectedFrame) -> bool:
    """Register onto deduped timeline (by game second), then wake the predict worker."""
    snap_sec = int(frame.snap.get("time_sec", 0) or frame.snap.get("snapshot_time_sec", 0) or 0)
    with ctx._timeline_lock:
        by_sec = ctx.deduped_timeline.setdefault(frame.battle_id, {})
        by_sec[snap_sec] = frame
    try:
        ctx.frame_queue.put_nowait((frame.battle_id, snap_sec))
        return True
    except queue.Full:
        try:
            ctx.frame_queue.get_nowait()
        except queue.Empty:
            pass
        try:
            ctx.frame_queue.put_nowait((frame.battle_id, snap_sec))
            return True
        except queue.Full:
            print(f"[WARN] frame queue full, drop {frame.battle_id}@{snap_sec}s")
            return False


def load_model_async(ctx: PipelineContext) -> None:
    """Load the 47 MB model after crawling has already started.

    2026-10-29: load_model() ran before the first heartbeat, so a slow disk made
    a perfectly healthy collector look dead for five minutes and the supervisor
    killed it. Acquisition must never wait for the model.
    """
    try:
        artifact = load_model()
    except Exception as exc:
        print(f"[WARN] 模型加载失败，继续仅采集原始数据: {exc}")
        artifact = None
    if not artifact:
        print("[WARN] 无可用模型，仅采集；修复模型后重启恢复预测")
        ctx.model_state = "unavailable"
        ctx.auto_train = False
        _COLLECTOR_STATUS.update(model_state="unavailable", model_name="Unknown")
        _write_heartbeat(force=True)
        return
    ctx.artifact = artifact
    ctx.model_state = "ready"
    _COLLECTOR_STATUS.update(model_state="ready",
                             model_name=artifact.get("model_name", "Unknown"))
    _write_heartbeat(force=True)
    print(f"[INIT] 模型加载完成: {artifact.get('model_name', 'Unknown')}（采集未中断）")
    with ctx._timeline_lock:
        pending = [(battle_id, sec) for battle_id, by_sec in ctx.deduped_timeline.items()
                   for sec in sorted(by_sec)]
    requeued = 0
    for battle_id, sec in pending:
        try:
            ctx.frame_queue.put_nowait((battle_id, sec))
            requeued += 1
        except queue.Full:
            break
    if requeued:
        print(f"[INIT] 补算加载期间采集的 {requeued} 个局时快照")


def predict_worker(ctx: PipelineContext) -> None:
    """Model module: pull unique game-seconds from the deduped timeline and score."""
    print("[PRED] 推理线程已启动（按去重局时提取 → 算胜率）")
    while not ctx.stop_event.is_set():
        try:
            item = ctx.frame_queue.get(timeout=0.2)
        except queue.Empty:
            continue
        if item is _SENTINEL:
            break
        try:
            if isinstance(item, CollectedFrame):
                process_prediction_frame(ctx, item)
            elif isinstance(item, tuple) and len(item) == 2:
                battle_id, snap_sec = item
                process_prediction_by_sec(ctx, str(battle_id), int(snap_sec))
        except Exception as exc:
            print(f"[PRED-ERR] {exc}")
            import traceback

            traceback.print_exc()
        finally:
            ctx.frame_queue.task_done()
    print("[PRED] 推理线程已退出")


def process_prediction_by_sec(ctx: PipelineContext, battle_id: str, snap_sec: int) -> None:
    """Pull one unique game-second from the deduped timeline and score win probability."""
    predicted = ctx.predicted_secs.setdefault(battle_id, set())
    if snap_sec > 0 and snap_sec in predicted:
        return
    if not ctx.artifact:
        # Model still warming up: keep the frame in the timeline and retry.
        # In collect-only/unavailable mode there will never be a model, so do
        # not spin forever on the same item.
        if ctx.model_state == "loading":
            try:
                ctx.frame_queue.put_nowait((battle_id, snap_sec))
            except queue.Full:
                pass
            time.sleep(0.25)
        return

    with ctx._timeline_lock:
        frame = (ctx.deduped_timeline.get(battle_id) or {}).get(snap_sec)
    if frame is None:
        return

    if snap_sec > 0:
        predicted.add(snap_sec)
    _emit_prediction(ctx, frame)


def process_prediction_frame(ctx: PipelineContext, frame: CollectedFrame) -> None:
    """Direct entry: ensure frame is on the deduped timeline, then score that second."""
    snap_sec = int(frame.snap.get("time_sec", 0) or frame.snap.get("snapshot_time_sec", 0) or 0)
    with ctx._timeline_lock:
        ctx.deduped_timeline.setdefault(frame.battle_id, {})[snap_sec] = frame
    process_prediction_by_sec(ctx, frame.battle_id, snap_sec)


def _feature_hash(feats: dict, artifact: dict) -> str:
    cols = artifact.get("feature_columns") or []
    vals = []
    for c in cols:
        try:
            vals.append(round(float(feats.get(c, 0.0) or 0.0), 4))
        except (TypeError, ValueError):
            vals.append(None)
    return hashlib.sha1(json.dumps(vals, separators=(",", ":")).encode("utf-8")).hexdigest()[:12]


def _emit_prediction(ctx: PipelineContext, frame: CollectedFrame) -> None:
    battle_id = frame.battle_id
    snap = frame.snap
    history = ctx.predict_history.setdefault(battle_id, [])
    artifact = ctx.artifact
    snap_sec = int(snap.get("time_sec", 0) or snap.get("snapshot_time_sec", 0) or 0)

    _t0 = time.perf_counter()
    prob, feats, explain = predict_probability(artifact, snap, history)
    predict_latency_ms = (time.perf_counter() - _t0) * 1000.0
    history.append(snap)
    if len(history) > 40:
        history[:] = history[-40:]

    ctx.last_velocity_by_battle[battle_id] = float(feats.get("gold_diff_velocity", 0.0))

    gold_guard_applied = float(feats.get("_gold_guard_applied", 0) or 0) > 0.5
    row = {
        "collected_at": frame.collected_at,
        "match_id": frame.match_id,
        "battle_id": battle_id,
        "minute": round(float(snap.get("minute", 0)), 2),
        "snapshot_time_sec": snap_sec,
        "lag_sec": frame.lag_sec if frame.lag_sec is not None else "",
        "camp1_team": snap.get("camp1_team"),
        "camp2_team": snap.get("camp2_team"),
        "camp1_win_prob": round(prob, 5),
        "camp2_win_prob": round(1 - prob, 5),
        "gold_diff": snap.get("camp1_gold", 0) - snap.get("camp2_gold", 0),
        "kill_diff": snap.get("camp1_kill", 0) - snap.get("camp2_kill", 0),
        "tower_diff": snap.get("camp1_tower", 0) - snap.get("camp2_tower", 0),
        "objective_value_score": round(float(feats.get("objective_value_score", 0)), 4),
        "tempo_swing_score": round(float(feats.get("tempo_swing_score", 0)), 4),
        "top_factor": explain[0]["factor"] if explain else "",
        # FeatureBuilder.explain 只是"原始特征绝对值最大"，不是模型归因；显式标注，避免误读
        "top_factor_kind": "narrative_feature_magnitude",
        "top_factor_note": "描述性输入摘要，非模型归因（不是 SHAP/因果贡献）",
        "gold_guard_applied": int(gold_guard_applied),
        "model_version": artifact.get("version") or "",
        "model_trained_at": artifact.get("trained_at") or "",
        "model_fp": f"{artifact.get('version') or ''}|{artifact.get('trained_at') or ''}|{len(artifact.get('feature_columns') or [])}",
        "feature_hash": _feature_hash(feats, artifact),
        "predict_latency_ms": round(predict_latency_ms, 2),
        "prob_raw": round(float(feats.get("_prob_raw", prob)), 5),
        "prob_model": round(float(prob), 5),
        "status": snap.get("status"),
        "win_camp": snap.get("win_camp"),
    }
    append_prediction(battle_id, row)

    battle_state = "finished" if int(snap.get("status", 0) or 0) == 2 else "running"
    write_status(
        {
            "state": battle_state,
            "match_id": frame.match_id,
            "battle_id": battle_id,
            "match": frame.match_name,
            "camp1_team": snap.get("camp1_team"),
            "camp2_team": snap.get("camp2_team"),
            "minute": row["minute"],
            "snapshot_time_sec": row["snapshot_time_sec"],
            "lag_sec": row["lag_sec"],
            "clock_jump": frame.clock_jump,
            "low_confidence": bool(feats.get("_low_confidence", 0)),
            "confidence": feats.get("_confidence", "high"),
            "camp1_win_prob": row["camp1_win_prob"],
            "camp2_win_prob": row["camp2_win_prob"],
            "gold_diff": row["gold_diff"],
            "top_factor": row["top_factor"],
            "top_factor_kind": "narrative_feature_magnitude",
            "top_factor_note": "描述性输入摘要，非模型归因（不是 SHAP/因果贡献）",
            "gold_guard_applied": gold_guard_applied,
            "poll_interval_sec": ctx.collect_interval_sec,
            "queue_size": ctx.frame_queue.qsize(),
            "pipeline": "crawl||predict@deduped_sec",
            "prediction_path": str(PREDICTION_DIR / f"{battle_id}.csv"),
            "frame_path": str(FRAME_DIR / f"{battle_id}.csv"),
            "model_name": artifact.get("model_name", "Unknown"),
        },
        ctx,
    )
    lag_note = (
        f" lag={frame.lag_sec:+.0f}s"
        if isinstance(frame.lag_sec, (int, float))
        else (" lag=clock_jump" if frame.clock_jump else "")
    )
    print(
        f"[PRED] {battle_id} t={snap_sec}s ({row['minute']:.1f}min) "
        f"{row['camp1_team']} {row['camp1_win_prob']:.1%} vs {row['camp2_team']} {row['camp2_win_prob']:.1%}"
        f"{lag_note} · q={ctx.frame_queue.qsize()}"
    )
    if int(snap.get("status", 0) or 0) == 2:
        ctx.predict_history.pop(battle_id, None)
        ctx.battle_anchors.pop(battle_id, None)
        ctx.last_velocity_by_battle.pop(battle_id, None)
        ctx.last_lag_sec.pop(battle_id, None)
        # Keep predicted_secs: the API may keep returning the final status=2
        # frame; popping it would append the same prediction on every poll.
        with ctx._timeline_lock:
            ctx.deduped_timeline.pop(battle_id, None)


def collect_once(
    args,
    match_id: str,
    match: ScheduleMatch | None,
    ctx: PipelineContext,
) -> tuple[str, float]:
    """Crawl module only: fetch + save + enqueue. Never runs the model."""
    _COLLECTOR_STATUS["last_poll_epoch"] = time.time()
    schedule = ScheduleCenter(args.league_id)
    match = match or schedule.get_match_by_id(match_id)
    wait_sec = max(1.0, float(args.interval))
    crawl_sec = float(args.interval)

    if not match_id:
        write_status({"state": "waiting_schedule", "message": "未发现可监控赛程"}, ctx)
        print("[WAIT] 未发现可监控赛程")
        return "waiting_schedule", wait_sec

    # Priors may take up to 180 seconds. They must never block acquisition.
    if match_id not in _PRIOR_ATTEMPTED and match_id not in _PRIOR_SCHEDULED:
        _PRIOR_SCHEDULED.add(match_id)
        _SAVE_EXECUTOR.submit(ensure_prematch_prior, match_id)

    if match and match.status == 2:
        print(f"[DONE] match={match_id} 已结束 · {match.display_name}")
        _mark_waiting()
        return "match_finished", wait_sec

    battle_id = args.battle_id
    used_sticky = False
    now_mono = time.monotonic()
    # Match API resolve at most ~1Hz; battle crawl stays at --interval.
    if not battle_id:
        sticky = ctx.sticky_battle_by_match.get(match_id)
        if sticky and (now_mono - ctx.last_battle_resolve_at) < 1.0:
            battle_id = sticky
            used_sticky = True
        else:
            battle_id = schedule.fetch_live_battle_id(match_id)
            ctx.last_battle_resolve_at = now_mono
            if battle_id:
                ctx.sticky_battle_by_match[match_id] = battle_id
            elif sticky:
                battle_id = sticky
                used_sticky = True
    else:
        ctx.sticky_battle_by_match[match_id] = battle_id
        ctx.last_battle_resolve_at = now_mono

    if not battle_id:
        _COLLECTOR_STATUS.update(battle_id=None, source_status=0,
                                 source_time_sec=None, last_poll_at=None)
        match_info = schedule.get_match_by_id(match_id) or match
        if match_info and match_info.status == 2:
            print(f"[DONE] match={match_id} 已结束 · {match_info.display_name}")
            return "match_finished", wait_sec
        if match_info and match_info.status == 1:
            write_status(
                {
                    "state": "waiting_battle",
                    "match_id": match_id,
                    "match": match.display_name if match else match_id,
                    "message": "局间休息，等待下一局 battle_id",
                    "pipeline": "crawl||predict",
                },
                ctx,
            )
            print(f"[WAIT] match={match_id} 局间休息，等待下一局")
            return "waiting_battle", wait_sec
        write_status(
            {
                "state": "waiting_battle",
                "match_id": match_id,
                "match": match.display_name if match else match_id,
                "message": "比赛尚未生成 battle_id",
                "pipeline": "crawl||predict",
            },
            ctx,
        )
        print(f"[WAIT] match={match_id} 尚未生成 battle_id")
        return "waiting_battle", wait_sec

    if used_sticky:
        # Keep sticky quiet unless rare — print at most via status.
        pass

    if battle_id in ctx.finished_battles:
        return "battle_finished", wait_sec

    if battle_id not in ctx.replayed_battles:
        ctx.replayed_battles.add(battle_id)
        replay_gap(ctx, match_id, battle_id, match.display_name if match else match_id)

    history = ctx.collect_history.setdefault(battle_id, [])
    min_game_sec = 0
    if history:
        min_game_sec = int(
            history[-1].get("time_sec", 0) or history[-1].get("snapshot_time_sec", 0) or 0
        )

    # Loop liveness is recorded before the network call: an API outage is not a
    # hung collector, while a request that never returns still goes stale.
    _COLLECTOR_STATUS["last_poll_at"] = datetime.now().isoformat(timespec="seconds")
    raw = fetch_freshest_battle(
        battle_id,
        n_probes=args.probes,
        gap_sec=args.probe_gap,
        parallel=not args.sequential_probes,
        min_game_sec=min_game_sec,
    )
    if not raw:
        write_status(
            {
                "state": "api_error",
                "match_id": match_id,
                "battle_id": battle_id,
                "message": "battle API 不可用",
            },
            ctx,
        )
        print(f"[ERR] battle API unavailable: {battle_id}")
        return "error", wait_sec

    # 回显校验：以前直接拿请求参数当 battle_id 用，等于默认官方不会串局。
    # 一旦串了，别场的整局数据会被存进这一局，而且事后无法从落盘文件里看出来。
    echoed_id = str((raw.get("data") or {}).get("battle_id") or "").strip()
    if echoed_id and echoed_id != battle_id:
        print(f"[ERR] battle_id 回显不一致：请求 {battle_id} 返回 {echoed_id}，本帧不入库")
        _COLLECTOR_STATUS["last_poll_at"] = datetime.now().isoformat(timespec="seconds")
        try:
            from notify_alert import notify
            notify("采集收到别局数据", f"请求 {battle_id} 返回 {echoed_id}",
                   level="warning", key=f"echo:{battle_id}")
        except Exception:
            pass
        return "error", wait_sec

    snap = parse_snapshot(raw.get("data", {}), battle_id)
    progress_time = datetime.now().isoformat(timespec="seconds")
    source_sec = int(snap.get("time_sec", 0) or 0)
    # Loop liveness: written even for stale/duplicate frames, so a flapping
    # official feed is not mistaken for a hung collector by the watchdog.
    _COLLECTOR_STATUS["last_poll_at"] = progress_time

    if not is_monotonic_snapshot(snap, history):
        prev_t = int(history[-1].get("time_sec", 0) or history[-1].get("snapshot_time_sec", 0) or 0)
        cur_t = int(snap.get("time_sec", 0) or snap.get("snapshot_time_sec", 0) or 0)
        # Official replicas sometimes lag by 20-60s. Retry wider once (rate
        # limited) instead of silently dropping the frame and leaving a gap.
        global _LAST_STALE_RETRY
        if time.monotonic() - _LAST_STALE_RETRY >= 2.0:
            _LAST_STALE_RETRY = time.monotonic()
            retry = fetch_freshest_battle(
                battle_id,
                n_probes=max(3, int(args.probes)),
                gap_sec=args.probe_gap,
                parallel=not args.sequential_probes,
                min_game_sec=prev_t,
            )
            retry_snap = parse_snapshot((retry or {}).get("data", {}), battle_id) if retry else None
            if retry_snap and is_monotonic_snapshot(retry_snap, history):
                raw, snap, source_sec = retry, retry_snap, int(
                    retry_snap.get("time_sec", 0) or retry_snap.get("snapshot_time_sec", 0) or 0)
                _COLLECTOR_STATUS["last_poll_at"] = datetime.now().isoformat(timespec="seconds")
            else:
                collector_heartbeat(state="live", battle_id=battle_id, match_id=match_id,
                                    source_status=int(snap.get("status", 0) or 0),
                                    last_poll_at=_COLLECTOR_STATUS["last_poll_at"])
                print(
                    f"[SKIP] {battle_id} 快照倒退 {cur_t}s < {prev_t}s "
                    f"(tol={REWIND_ACCEPT_TOLERANCE_SEC}s)，丢弃"
                )
                return "stale_snapshot", crawl_sec
        else:
            collector_heartbeat(state="live", battle_id=battle_id, match_id=match_id,
                                source_status=int(snap.get("status", 0) or 0),
                                last_poll_at=_COLLECTOR_STATUS["last_poll_at"])
            print(
                f"[SKIP] {battle_id} 快照倒退 {cur_t}s < {prev_t}s "
                f"(tol={REWIND_ACCEPT_TOLERANCE_SEC}s)，丢弃"
            )
            return "stale_snapshot", crawl_sec

    if (_COLLECTOR_STATUS.get("battle_id") != battle_id
            or _COLLECTOR_STATUS.get("source_time_sec") != source_sec):
        _COLLECTOR_STATUS["source_advanced_at"] = progress_time

    prev_t = 0
    if history:
        prev_t = int(history[-1].get("time_sec", 0) or history[-1].get("snapshot_time_sec", 0) or 0)
    cur_t = int(snap.get("time_sec", 0) or snap.get("snapshot_time_sec", 0) or 0)
    if cur_t <= prev_t:
        # A single probe can stay pinned to a lagging official replica while a
        # sibling replica already advanced. If the clock has been flat for
        # >10 s, probe wider once (rate limited); a fresher replica fills the
        # gap that used to show up as "官方源空档".
        now_mono = time.monotonic()
        last_advance = ctx.last_source_advance.get(battle_id, now_mono)
        if (now_mono - last_advance > 10.0
                and now_mono - _LAST_STALE_RETRY >= 2.0):
            _LAST_STALE_RETRY = now_mono
            retry = fetch_freshest_battle(
                battle_id,
                n_probes=max(3, int(args.probes)),
                gap_sec=args.probe_gap,
                parallel=not args.sequential_probes,
                min_game_sec=prev_t,
            )
            retry_snap = parse_snapshot((retry or {}).get("data", {}), battle_id) if retry else None
            retry_t = int((retry_snap or {}).get("time_sec", 0)
                          or (retry_snap or {}).get("snapshot_time_sec", 0) or 0)
            if retry_snap and retry_t > cur_t:
                print(f"[REPROBE] {battle_id} 单副本停在 {cur_t}s，"
                      f"{max(3, int(args.probes))} 副本取到 {retry_t}s")
                raw, snap, source_sec, cur_t = retry, retry_snap, retry_t, retry_t
                _COLLECTOR_STATUS["last_poll_at"] = datetime.now().isoformat(timespec="seconds")
        if cur_t > prev_t:
            ctx.last_source_advance[battle_id] = time.monotonic()
        else:
            ctx.last_source_advance.setdefault(battle_id, time.monotonic())
    else:
        ctx.last_source_advance[battle_id] = time.monotonic()

    collector_heartbeat(state="live", battle_id=battle_id, match_id=match_id,
                        source_status=int(snap.get("status", 0) or 0),
                        source_time_sec=source_sec,
                        last_poll_at=_COLLECTOR_STATUS["last_poll_at"])

    if (
        int(snap.get("status", 0) or 0) == 2
        and history
        and int(history[-1].get("status", 0) or 0) == 2
    ):
        if ctx.sticky_battle_by_match.get(match_id) == battle_id:
            ctx.sticky_battle_by_match.pop(match_id, None)
        ctx.collect_history.pop(battle_id, None)
        ctx.last_snapshot_sec.pop(battle_id, None)
        ctx.last_frame_key.pop(battle_id, None)
        ctx.finished_battles.add(battle_id)
        finalize_battle_coverage(ctx, battle_id, snap)
        _mark_waiting()
        match_info = schedule.get_match_by_id(match_id)
        if match_info and match_info.status == 2:
            return "match_finished", wait_sec
        return "battle_finished", wait_sec

    ensure_battle_anchor(ctx, battle_id, snap)
    anchor = ctx.battle_anchors.get(battle_id)
    raw_lag = compute_lag_sec(snap, anchor[0], anchor[1]) if anchor else None
    prev_lag = ctx.last_lag_sec.get(battle_id)
    lag_sec, clock_jump = sanitize_lag_sec(raw_lag, prev_lag)
    if lag_sec is not None:
        ctx.last_lag_sec[battle_id] = lag_sec

    snap_sec = int(snap.get("time_sec", 0) or snap.get("snapshot_time_sec", 0) or 0)
    dedupe_key = frame_dedupe_key(snap)
    # Raw archival has its own content identity: two responses in the same
    # game-second may differ only in equipment/BP/player fields.
    raw_digest = hashlib.sha256(json.dumps(raw.get("data", raw), sort_keys=True,
                                          ensure_ascii=False).encode("utf-8")).hexdigest()
    if ctx.last_raw_digest.get(battle_id) != raw_digest:
        raw_path = save_raw_snapshot(battle_id, raw)
        _COLLECTOR_STATUS.update(last_saved_at=datetime.now().isoformat(timespec="seconds"),
                                 last_saved_path=str(raw_path))
        ctx.last_raw_digest[battle_id] = raw_digest
    # Middle gate: only persist / enqueue unique board states.
    if ctx.last_frame_key.get(battle_id) == dedupe_key:
        return "duplicate", crawl_sec

    collected_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    frame_row = {
        "collected_at": collected_at,
        "match_id": match_id,
        "battle_id": battle_id,
        "minute": round(float(snap.get("minute", 0)), 2),
        "snapshot_time_sec": snap_sec,
        "lag_sec": lag_sec if lag_sec is not None else "",
        "camp1_team": snap.get("camp1_team"),
        "camp2_team": snap.get("camp2_team"),
        "gold_diff": snap.get("camp1_gold", 0) - snap.get("camp2_gold", 0),
        "kill_diff": snap.get("camp1_kill", 0) - snap.get("camp2_kill", 0),
        "tower_diff": snap.get("camp1_tower", 0) - snap.get("camp2_tower", 0),
        "status": snap.get("status"),
        "win_camp": snap.get("win_camp"),
        "missing_camp_fields": snap.get("missing_camp_fields", ""),
        "team_name_fallback": snap.get("team_name_fallback", 0),
    }
    append_frame(battle_id, frame_row)
    history.append(snap)
    if len(history) > 80:
        history[:] = history[-80:]
    ctx.last_snapshot_sec[battle_id] = snap_sec
    ctx.last_frame_key[battle_id] = dedupe_key

    match_name = match.display_name if match else match_id
    # Always enqueue: the predict worker holds frames while the model warms up,
    # then re-scores them. Acquisition never depends on model load order.
    if ctx.model_state != "disabled":
        enqueue_frame(
            ctx,
            CollectedFrame(
                match_id=match_id,
                battle_id=battle_id,
                match_name=match_name,
                collected_at=collected_at,
                raw=raw,
                snap=snap,
                lag_sec=lag_sec,
                clock_jump=clock_jump,
            ),
        )

    lag_note = (
        f" lag={lag_sec:+.0f}s"
        if isinstance(lag_sec, (int, float))
        else (" lag=clock_jump" if clock_jump else "")
    )
    print(
        f"[CRAWL] {battle_id} {frame_row['minute']:.1f}min "
        f"gold={frame_row['gold_diff']:+d}{lag_note} · next={crawl_sec}s · q={ctx.frame_queue.qsize()}"
    )

    match_info = schedule.get_match_by_id(match_id)
    if match_info and match_info.status == 2:
        finalize_battle_coverage(ctx, battle_id, snap)
        _mark_waiting()
        return "match_finished", crawl_sec
    if int(snap.get("status", 0) or 0) == 2:
        # Finishing frame already queued for predict; only drop crawl sticky/history.
        ctx.finished_battles.add(battle_id)
        clear_battle_runtime(ctx, match_id, battle_id)
        finalize_battle_coverage(ctx, battle_id, snap)
        _mark_waiting()
        return "battle_finished", wait_sec
    return "running", crawl_sec


def run_once(
    args,
    artifact,
    history_by_battle: dict[str, list[dict]],
    match_id: str,
    match: ScheduleMatch | None = None,
    ctx: PipelineContext | None = None,
) -> tuple[str, float]:
    """Backward-compatible wrapper: crawl once and wait briefly for predict queue."""
    if ctx is None:
        raise RuntimeError("run_once requires PipelineContext in parallel pipeline")
    # Keep legacy history alias pointing at collect history for callers.
    history_by_battle.clear()
    history_by_battle.update(ctx.collect_history)
    outcome, poll_sec = collect_once(args, match_id, match, ctx)
    # Give predictor a short chance to drain for --once smoke runs.
    if outcome == "running":
        deadline = time.time() + 2.0
        while ctx.frame_queue.unfinished_tasks and time.time() < deadline:
            time.sleep(0.05)
    return outcome, poll_sec


def advance_to_next_match(
    schedule: ScheduleCenter,
    finished_match_id: str,
    date: str | None,
    prestart_poll: int,
    ctx: PipelineContext,
) -> tuple[str | None, ScheduleMatch | None]:
    next_match = schedule.next_match_after(finished_match_id, date=date)
    if not next_match:
        write_status(
            {
                "state": "day_complete",
                "finished_match_id": finished_match_id,
                "message": "今日赛程已全部结束",
            }
        )
        print("[WAIT] 今日赛程已全部结束")
        maybe_train_after_batch(ctx, schedule, date, reason="day_complete")
        return None, None

    write_status(
        {
            "state": "waiting_next_match",
            "finished_match_id": finished_match_id,
            "next_match_id": next_match.match_id,
            "next_match": next_match.display_name,
            "team1": next_match.team1,
            "team2": next_match.team2,
            "start_time": next_match.start_time.strftime("%Y-%m-%d %H:%M:%S") if next_match.start_time else "",
            "message": f"上一场已结束，等待 {next_match.team1} vs {next_match.team2}",
        }
    )
    print(f"[NEXT] 上一场结束，下一场 {next_match.team1} vs {next_match.team2}")
    if next_match.start_time and datetime.now() < next_match.start_time:
        switched = wait_until_start(next_match, prestart_poll, ctx, label="waiting_next_match", schedule=schedule)
        if switched:
            return switched.match_id, switched
    return next_match.match_id, next_match


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--match-id", default=None, help="指定 match_id；为空则自动从赛程选择")
    parser.add_argument("--battle-id", default=None, help="指定 battle_id；为空则从 match_id 自动发现")
    parser.add_argument("--league-id", type=int, default=LEAGUE_ID)
    parser.add_argument(
        "--date",
        default=None,
        help="起始日期 YYYY-MM-DD（默认今天）。注意这是「起始偏好」不是锁定值："
             "该日比赛全部结束后会自动滚动到下一个有比赛的日期，跨天无需重启进程。",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=0.1,
        help="采集间隔秒（默认 0.1；仅影响爬虫，模型异步并行）",
    )
    parser.add_argument(
        "--interval-hot",
        type=float,
        default=0.1,
        help="团战期采集间隔秒（仅 --adaptive 时生效，默认 0.1）",
    )
    parser.add_argument("--hot-velocity", type=float, default=150.0, help="判定团战期的 gold_diff_velocity 阈值")
    parser.add_argument("--adaptive", action="store_true", default=False, help="按经济波动自适应间隔（默认关闭）")
    parser.add_argument("--no-adaptive", action="store_true", help="禁用自适应轮询（默认已禁用）")
    parser.add_argument("--prestart-poll", type=int, default=20, help="等待开赛时的检查间隔秒")
    parser.add_argument("--probes", type=int, default=1, help="每次采集探测 API 副本次数（高频默认 1）")
    parser.add_argument("--probe-gap", type=float, default=0.05, help="串行探测时的间隔秒")
    parser.add_argument("--sequential-probes", action="store_true", help="使用串行探测（默认并行）")
    parser.add_argument("--once", action="store_true", help="只运行一次")
    parser.add_argument("--stop-when-finished", action="store_true", help="当前局结束后停止")
    parser.add_argument("--auto-next", action="store_true", help="一场结束后自动等待并切换到下一场")
    parser.add_argument("--no-auto-next", action="store_true", help="禁用自动切换下一场")
    parser.add_argument("--auto-train", action="store_true", help="当日比赛打满后自动重训一次（默认开启）")
    parser.add_argument("--no-auto-train", action="store_true", help="禁用自动重训")
    parser.add_argument("--collect-only", action="store_true", help="仅采集原始快照，不加载模型或生成预测")
    parser.add_argument(
        "--train-after-matches",
        type=int,
        default=0,
        help="打满几场后训练；0 表示今日赛程全部结束后再训练",
    )
    parser.add_argument("--peer", action="store_true",
                        help="主备模式：抢到 collector 锁的进程采集，另一个预热待命并接管")
    parser.add_argument("--role", choices=("primary", "standby"), default="primary",
                        help="主备身份（只影响日志/租约；先抢到锁的进程采集）")
    parser.add_argument("--standby", action="store_true", help="等价于 --peer --role standby")
    return parser


def run_leader(args, preloaded_artifact: dict | None = None, role: str = "primary",
               collector_lock: ProcessLock | None = None):
    recover_stale_train_status()

    auto_next = not args.no_auto_next and (args.auto_next or not args.match_id)
    auto_train = not args.no_auto_train and not args.collect_only
    collect_only = bool(args.collect_only)
    artifact = dict(preloaded_artifact) if preloaded_artifact else {}

    ctx = PipelineContext(
        artifact=artifact,
        auto_train=auto_train and not collect_only,
        train_after_matches=args.train_after_matches,
        last_data_sig=realtime_data_signature(),
        collect_interval_sec=float(args.interval),
        role=role,
    )
    ctx.model_state = "disabled" if collect_only else ("ready" if artifact else "loading")
    cleanup_shadow()

    pred_thread = threading.Thread(target=predict_worker, args=(ctx,), name="kpl-predict", daemon=True)
    if not collect_only:
        pred_thread.start()
    threading.Thread(target=health_server, args=(ctx,), name="kpl-health", daemon=True).start()
    threading.Thread(target=heartbeat_worker, args=(ctx,), name="kpl-heartbeat", daemon=True).start()
    threading.Thread(target=lease_worker, args=(ctx,), name="kpl-lease", daemon=True).start()

    write_status(
        {
            "state": "starting",
            "model_name": artifact.get("model_name", "loading"),
            "model_state": ctx.model_state,
            "role": role,
            "auto_next": auto_next,
            "auto_train": auto_train,
            "train_after_matches": args.train_after_matches,
            "pipeline": "crawl||predict",
            "poll_interval_sec": float(args.interval),
            "probes": args.probes,
        },
        ctx,
    )
    print(
        f"[INIT] 并行流水线（role={role}）：爬虫立即启动 interval={args.interval}s "
        f"probes={args.probes} | 模型{'已预热' if artifact else '后台加载'}"
    )
    if not collect_only and not artifact:
        threading.Thread(target=load_model_async, args=(ctx,), name="kpl-model-load",
                         daemon=True).start()
    history_by_battle: dict[str, list[dict]] = {}
    schedule = ScheduleCenter(args.league_id)
    current_match_id = args.match_id
    current_match: ScheduleMatch | None = None
    last_schedule_refresh = 0.0
    # args.date 只是「起始偏好」，不是锁定值：当日比赛全结束后会自动滚到下一个有比赛的日期。
    # 2026-10-18 事故就是因为 date 被钉死在启动日，进程不重启就永远找不到新比赛。
    current_date = args.date

    try:
        n = refresh_schedule_archive(args.league_id)
        print(f"[INIT] 已刷新赛程缓存 {n} 场")
        last_schedule_refresh = time.monotonic()
    except Exception as exc:
        print(f"[WARN] 赛程缓存刷新失败: {exc}")

    try:
        while True:
            try:
                if current_match_id:
                    current_match = schedule.get_match_by_id(current_match_id)
                    if not current_match:
                        current_match, picked = schedule.resolve_monitor_match_rolling(current_date)
                        if picked:
                            current_date = picked
                        if current_match:
                            current_match_id = current_match.match_id
                else:
                    current_match, picked = schedule.resolve_monitor_match_rolling(current_date)
                    if picked:
                        current_date = picked
                    if current_match:
                        current_match_id = current_match.match_id

                if not current_match:
                    write_status({"state": "waiting_schedule", "message": "暂无可监控比赛"}, ctx)
                    print("[WAIT] 暂无可监控比赛")
                    maybe_train_after_batch(ctx, schedule, current_date, reason="waiting_schedule")
                    if args.once:
                        break
                    time.sleep(args.prestart_poll)
                    continue

                collector_heartbeat(state="polling", match_id=current_match.match_id)

                current_match_id = current_match.match_id
                if current_match.start_time and datetime.now() < current_match.start_time:
                    switched = wait_until_start(current_match, args.prestart_poll, ctx, schedule=schedule)
                    if switched:
                        current_match = switched
                        current_match_id = switched.match_id
                        current_date = switched.start_time.strftime("%Y-%m-%d") if switched.start_time else current_date
                        # 切换到「更早但还没开赛」的场次时不能直接 collect，回到循环顶部重新等待。
                        if current_match.start_time and datetime.now() < current_match.start_time:
                            args.battle_id = None
                            continue

                cycle_args = argparse.Namespace(
                    league_id=args.league_id,
                    match_id=current_match_id,
                    battle_id=None,
                    date=current_date,
                    probes=args.probes,
                    probe_gap=args.probe_gap,
                    sequential_probes=args.sequential_probes,
                    interval=args.interval,
                    interval_hot=args.interval_hot,
                    hot_velocity=args.hot_velocity,
                    adaptive=args.adaptive,
                )
                t0 = time.monotonic()
                outcome, poll_sec = collect_once(cycle_args, current_match_id, current_match, ctx)
                history_by_battle = ctx.collect_history

                if outcome == "match_finished":
                    maybe_train_after_batch(ctx, schedule, current_date, reason="match_finished")
                    if time.monotonic() - last_schedule_refresh > 1800:
                        try:
                            refresh_schedule_archive(args.league_id)
                            last_schedule_refresh = time.monotonic()
                        except Exception:
                            pass

                if args.once or (outcome in {"battle_finished", "match_finished"} and args.stop_when_finished):
                    break

                if outcome == "match_finished" and auto_next:
                    next_match_id, next_match = advance_to_next_match(
                        schedule, current_match_id, current_date, args.prestart_poll, ctx
                    )
                    if next_match_id:
                        current_match_id = next_match_id
                        current_match = next_match
                        args.battle_id = None
                        continue
                    if args.once:
                        break
                    time.sleep(args.prestart_poll)
                    current_match_id = None
                    continue

                # Pace crawl by wall clock: subtract time spent in collect_once.
                elapsed = time.monotonic() - t0
                sleep_sec = max(0.0, float(poll_sec) - elapsed)
                if sleep_sec > 0:
                    time.sleep(sleep_sec)
            except KeyboardInterrupt:
                try:
                    write_status({"state": "stopped", "message": "用户中断"}, ctx)
                except Exception:
                    pass
                print("\n[STOP] monitor interrupted")
                break
            except Exception as exc:
                # Never call write_status here: on 2026-10-29 the status write
                # itself failed and the error handler took the whole process down.
                _note_error("cycle", exc)
                print(f"[ERR] cycle crashed: {exc}")
                import traceback

                traceback.print_exc()
                time.sleep(max(5.0, float(args.interval)))
    finally:
        ctx.stop_event.set()
        try:
            ctx.frame_queue.put_nowait(_SENTINEL)
        except queue.Full:
            pass
        if pred_thread.ident is not None:
            pred_thread.join(timeout=3.0)


def _peer_status_write(role: str, state: str, extra: dict | None = None) -> None:
    write_json_quiet(RUNTIME / f"peer_{role}.json", {
        "role": role, "pid": os.getpid(), "state": state,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        **(extra or {}),
    })


def _try_collector_lock(lock: ProcessLock, attempts: int = 1, delay: float = 0.5) -> bool:
    for attempt in range(max(1, attempts)):
        if lock.acquire():
            return True
        if attempt + 1 < attempts:
            time.sleep(delay)
    return False


def _lease_age(lease: dict) -> float | None:
    try:
        epoch = float(lease.get("epoch") or 0)
    except (TypeError, ValueError):
        return None
    return max(0.0, time.time() - epoch) if epoch > 0 else None


def _recent_takeover(battle_id: str | None) -> bool:
    """Storm guard: at most one forced takeover per 5 minutes per battle.

    2026-11-04 G2/G5: a 15-30 s threshold treated normal official-API stalls as
    death; the watchdog killed 9 healthy collectors in 17 minutes and the game
    tails were lost. A real hang still gets caught (90 s), but a restart storm
    cannot destroy a live game.
    """
    state = read_json(RUNTIME / "freshness_watchdog.json")
    try:
        acted = float(state.get("acted_epoch") or 0)
    except (TypeError, ValueError):
        acted = 0.0
    if time.time() - acted >= 300:
        return False
    return not battle_id or state.get("battle_id") in (battle_id, None)


def _record_takeover(battle_id: str | None, pid: int, by: str) -> None:
    state = read_json(RUNTIME / "freshness_watchdog.json")
    state.update({"acted_epoch": round(time.time(), 3),
                  "acted_at": datetime.now().isoformat(timespec="seconds"),
                  "battle_id": battle_id, "killed_pid": pid, "by": by})
    write_json_quiet(RUNTIME / "freshness_watchdog.json", state)


def follower_wait(role: str, collector_lock: ProcessLock) -> tuple[bool, str | None, str | None]:
    """Warm standby: loopback health socket first, kernel mutex as fallback.

    The status/lease JSON files can be held by antivirus for tens of seconds;
    file ages are therefore only a fallback. The leader answers PING on a local
    socket with its in-memory poll epoch:
      - socket answers, poll epoch <= 60 s -> leader healthy (normal API stalls are 20-40 s)
      - socket answers, poll epoch > 60 s for 3 checks -> crawl hung, takeover
      - socket silent for 6 probes and heartbeat > 45 s -> process hung, takeover
      - no health port (old/startup code) -> kernel mutex + file-age fallback
    A forced takeover is rate-limited to one per 5 minutes per battle.
    """
    stale_confirm = 0
    hung_confirm = 0
    socket_fail = 0
    socket_ever_ok = False
    last_pid = 0
    while True:
        status = read_json(COLLECTOR_STATUS)
        lease = read_json(LEASE)
        hb_age = age_seconds(status.get("updated_at"))
        lease_age = _lease_age(lease)
        pid = int(status.get("pid") or lease.get("pid") or 0)
        if pid != last_pid:
            last_pid = pid
            socket_ever_ok = False
            socket_fail = 0
            hung_confirm = 0
        inherited_match = str(status.get("match_id") or lease.get("match_id") or "") or None
        inherited_battle = str(status.get("battle_id") or lease.get("battle_id") or "") or None
        port = int(lease.get("health_port") or 0)
        if port:
            health = _ping_health(port, timeout=0.35)
            if health is not None:
                socket_fail = 0
                socket_ever_ok = True
                try:
                    health_pid = int(health.get("pid") or pid or 0)
                except (TypeError, ValueError):
                    health_pid = pid
                try:
                    poll_epoch = float(health.get("last_poll_epoch") or 0)
                except (TypeError, ValueError):
                    poll_epoch = 0.0
                try:
                    started_epoch = float(health.get("started_epoch") or 0)
                except (TypeError, ValueError):
                    started_epoch = 0.0
                poll_age = time.time() - poll_epoch if poll_epoch else None
                starting = bool(started_epoch) and time.time() - started_epoch < 30
                if starting or (poll_age is not None and poll_age <= 60):
                    hung_confirm = 0
                    _peer_status_write(role, "standby", {
                        "leader_pid": health_pid or pid,
                        "poll_age_sec": round(poll_age, 1) if poll_age is not None else None,
                        "socket": True,
                    })
                    shadow_poll(lease, status)
                    time.sleep(1.0)
                    continue
                hung_confirm += 1
                if hung_confirm >= 3:
                    if _recent_takeover(status.get("battle_id")):
                        hung_confirm = 0
                        time.sleep(2.0)
                        continue
                    print(f"[PEER] leader {health_pid or pid} socket alive but poll "
                          f"{poll_age}s stale; terminating for takeover")
                    terminate_pid(health_pid or pid)
                    _record_takeover(status.get("battle_id"), health_pid or pid, role)
                    if _try_collector_lock(collector_lock, attempts=12, delay=0.3):
                        return True, inherited_match, inherited_battle
                time.sleep(1.0)
                continue
            socket_fail += 1
            # Leader may have exited cleanly between pings; its lock is free.
            if collector_lock.acquire():
                return True, inherited_match, inherited_battle
            if (socket_fail >= 6 and pid and pid_alive(pid)
                    and hb_age is not None and hb_age > 45):
                if _recent_takeover(status.get("battle_id")):
                    socket_fail = 0
                    time.sleep(2.0)
                    continue
                print(f"[PEER] leader {pid} health socket silent {socket_fail} probes "
                      f"(heartbeat {round(hb_age)}s); terminating for takeover")
                terminate_pid(pid)
                _record_takeover(status.get("battle_id"), pid, role)
                if _try_collector_lock(collector_lock, attempts=12, delay=0.3):
                    return True, inherited_match, inherited_battle
            _peer_status_write(role, "waiting", {
                "leader_pid": pid,
                "health_port": port,
                "socket_fail": socket_fail,
            })
            time.sleep(0.5)
            continue
        if os.name == "nt":
            leader_alive = LeaderMutex.is_held()
        else:
            leader_alive = ((lease_age is not None and lease_age <= LEASE_STALE_SEC)
                            or (hb_age is not None and hb_age <= FOLLOWER_STALE_SEC))
        if leader_alive:
            # A live mutex proves the process exists, not that its threads are
            # running. Two consecutive >30 s checks avoid the 10-20 s
            # antivirus/file-lock blips that caused the old fight.
            if hb_age is not None and hb_age > 30 and pid and pid_alive(pid):
                hung_confirm += 1
                if hung_confirm >= 2:
                    print(f"[PEER] leader {pid} mutex held but heartbeat {round(hb_age)}s "
                          f"stale; terminating for takeover")
                    terminate_pid(pid)
                    if _try_collector_lock(collector_lock, attempts=12, delay=0.3):
                        return True, inherited_match, inherited_battle
            else:
                hung_confirm = 0
            _peer_status_write(role, "standby", {
                "leader_pid": pid,
                "heartbeat_age_sec": round(hb_age, 1) if hb_age is not None else None,
                "lease_age_sec": round(lease_age, 1) if lease_age is not None else None,
                "mutex": leader_alive,
            })
            shadow_poll(lease, status)
            time.sleep(1.0)
            continue
        if collector_lock.acquire():
            return True, inherited_match, inherited_battle
        # No mutex but the file lock is held: a legacy leader (pre-mutex code)
        # or a leader whose CreateMutex failed. Give it 10 consecutive seconds
        # before forcing it down.
        alive = pid_alive(pid)
        if alive and pid != os.getpid():
            stale_confirm += 1
            if stale_confirm < 10:
                time.sleep(1.0)
                continue
            print(f"[PEER] leader {pid} holds the lock without the leader mutex "
                  f"for {stale_confirm}s, terminating for takeover")
            terminate_pid(pid)
            if _try_collector_lock(collector_lock, attempts=12, delay=0.3):
                return True, inherited_match, inherited_battle
        stale_confirm = 0
        _peer_status_write(role, "waiting", {
            "leader_pid": pid,
            "heartbeat_age_sec": round(hb_age, 1) if hb_age is not None else None,
            "lease_age_sec": round(lease_age, 1) if lease_age is not None else None,
            "mutex": leader_alive,
        })
        time.sleep(1.0)


def run_peer(args) -> int:
    role = "standby" if args.standby else args.role
    role_lock = ProcessLock(f"peer-{role}")
    if not role_lock.acquire():
        print(f"[PEER] {role} already running")
        return 0
    collector_lock = ProcessLock("collector")
    leader_mutex = None
    try:
        # Leader first: acquisition must not wait for the 47 MB model.
        if collector_lock.acquire():
            leader_mutex = LeaderMutex()
            _peer_status_write(role, "leader", {"mutex": leader_mutex.handle is not None})
            print(f"[PEER] {role} became leader pid={os.getpid()}")
            run_leader(args, None, role, collector_lock)
            return 0
        preloaded = None
        if not args.collect_only:
            try:
                preloaded = load_model()
            except Exception as exc:
                print(f"[WARN] 模型预加载失败: {exc}")
        _peer_status_write(role, "standby")
        print(f"[PEER] {role} warm standby pid={os.getpid()}")
        became_leader, match_id, battle_id = follower_wait(role, collector_lock)
        if not became_leader:
            return 0
        leader_mutex = LeaderMutex()
        if match_id:
            args.match_id = match_id
            # Inheriting a match must not silently disable auto-next; otherwise
            # the survivor stops monitoring after this match ends.
            if not getattr(args, "no_auto_next", False):
                args.auto_next = True
        if battle_id:
            args.battle_id = battle_id
        _peer_status_write(role, "leader", {"took_over": True,
                                            "mutex": leader_mutex.handle is not None})
        print(f"[PEER] {role} took over pid={os.getpid()} match={match_id} battle={battle_id}")
        try:
            from notify_alert import notify
            notify("KPL 采集器已接管",
                   f"{role} 接管采集（match={match_id} battle={battle_id}）",
                   key="peer_takeover", level="warning")
        except Exception as exc:
            _note_error("notify", exc)
        run_leader(args, preloaded, role, collector_lock)
        return 0
    finally:
        _peer_status_write(role, "exited")
        if leader_mutex is not None:
            leader_mutex.close()
        collector_lock.close()
        role_lock.close()


def main() -> int:
    args = build_parser().parse_args()
    if args.no_adaptive:
        args.adaptive = False
    if args.peer or args.standby:
        return run_peer(args)
    collector_lock = ProcessLock("collector")
    if not collector_lock.acquire():
        print("[LOCK] collector already running")
        return 0
    try:
        run_leader(args, None, "primary", collector_lock)
        return 0
    finally:
        collector_lock.close()


if __name__ == "__main__":
    sys.exit(main())

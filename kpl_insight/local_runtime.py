"""Manage only the fixed collector/exporter processes started by the local UI."""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
import csv
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading


class RuntimeControl:
    def __init__(self, site: Path, root: Path | None = None):
        self.site = site.resolve()
        self.root = (root or Path(os.environ.get("KPL_DATA_ROOT") or Path.cwd())).resolve()
        self.source = Path(__file__).resolve().parents[1]
        self.private = (self.source / "scripts/official_match_monitor.py").is_file()
        if self.private and root is None:
            self.root = self.source
        self.runtime = self.root / "data/realtime/runtime"
        self.children: dict[str, subprocess.Popen] = {}
        self.handles: dict[str, object] = {}
        self.log_names: set[str] = set()
        self.mode = None
        self.league = None
        self.started_at = None
        self.error = ""
        self.lock = threading.RLock()
        self.ownership = None

    def model_files(self):
        candidates = [self.root / "output/models" / name for name in (
            "v9_official_platform.joblib", "v8_realtime_enhanced.joblib",
            "v7_realtime_stacking.joblib", "v6_realtime_calibrated.joblib", "v5_realtime_voting.joblib")]
        candidates.append(self.root / "data/realtime/model_backup/v9_official_platform.joblib")
        return [p for p in candidates if p.is_file()]

    def python(self):
        candidate = self.source / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
        return str(candidate if candidate.is_file() else Path(sys.executable))

    def commands(self, mode: str, league: str):
        monitor = ([self.python(), "-u", str(self.source / "scripts/official_match_monitor.py")]
                   if self.private else [self.python(), "-u", "-m", "kpl_insight.collection.monitor"])
        monitor += ["--league-id", league, "--interval", "3", "--no-auto-train"]
        if mode == "collect":
            monitor.append("--collect-only")
        exporter = ([self.python(), "-u", str(self.source / "scripts/build_live_data.py")]
                    if self.private else [self.python(), "-u", "-m", "kpl_insight.site.export_live"])
        return {"collector": monitor, **({"exporter": exporter + ["--watch", "30"]} if mode == "predict" else {})}

    def default_league(self):
        """Follow today's/next scheduled event, falling back to the latest archive."""
        rows = []
        try:
            with (self.root / "data/realtime/schedule_archive.csv").open(encoding="utf-8-sig", newline="") as handle:
                rows = [{"leagueId": row.get("league_id"), "date": row.get("date"), "st": row.get("status")} for row in csv.DictReader(handle)]
        except OSError:
            pass
        if not rows:
            try:
                text = (self.site / "assets/schedule_all.js").read_text(encoding="utf-8")
                rows = json.loads(text.split("=", 1)[1].strip().rstrip(";"))
            except (OSError, ValueError, IndexError):
                rows = []
        rows = [row for row in rows if isinstance(row, dict) and str(row.get("leagueId", "")).isascii()
                and str(row.get("leagueId", "")).isdigit() and len(str(row["leagueId"])) <= 12
                and int(row["leagueId"]) > 0 and isinstance(row.get("date"), str)]
        today = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
        pending = [row for row in rows if row["date"] >= today and str(row.get("st")) != "2"]
        if pending:
            chosen = min(pending, key=lambda row: (row["date"], str(row.get("st")) != "1"))
        elif rows:
            past = [row for row in rows if row["date"] <= today]
            chosen = max(past, key=lambda row: row["date"]) if past else min(rows, key=lambda row: row["date"])
        else:
            raise ValueError("尚未找到可用赛程，请更新项目数据后重试。")
        return str(chosen["leagueId"])

    def _claim(self):
        self.runtime.mkdir(parents=True, exist_ok=True)
        handle = (self.runtime / "web-control.lock").open("a+b")
        if handle.seek(0, 2) == 0:
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
            raise ValueError("另一个本地控制面板已启动采集，请先在原面板停止。") from None
        self.ownership = handle

    def _release(self):
        if self.ownership:
            self.ownership.close()
            self.ownership = None

    def _tail(self, name):
        try:
            with (self.runtime / f"web-{name}.log").open("rb") as handle:
                handle.seek(0, 2)
                handle.seek(max(0, handle.tell() - 16000))
                return handle.read().decode("utf-8", errors="replace")[-12000:]
        except OSError:
            return ""

    def external_collector(self):
        """Recognize the development collector's OS lock without taking ownership."""
        path = self.runtime / "collector.lock"
        if not self.private or "collector" in self.children or not path.is_file():
            return False
        try:
            with path.open("r+b") as handle:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return False
        except OSError:
            return True

    def _read_json(self, path: Path) -> dict:
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    @staticmethod
    def _age(value) -> float | None:
        try:
            return max(0.0, (datetime.now() - datetime.fromisoformat(str(value))).total_seconds())
        except (TypeError, ValueError):
            return None

    def _snapshot_age(self, battle_id) -> float | None:
        if not battle_id:
            return None
        directory = self.root / "data/realtime/raw_snapshots" / str(battle_id)
        newest = 0.0
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    if not entry.name.endswith(".json"):
                        continue
                    try:
                        newest = max(newest, entry.stat().st_mtime)
                    except OSError:
                        continue
        except OSError:
            return None
        return max(0.0, datetime.now().timestamp() - newest) if newest else None

    def _frame_coverage(self, battle_id, duration=None):
        path = self.root / "data/realtime/frames" / f"{battle_id}.csv"
        seconds = set()
        try:
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                for row in csv.DictReader(handle):
                    try:
                        seconds.add(int(float(row.get("snapshot_time_sec") or 0)))
                    except (TypeError, ValueError):
                        continue
        except OSError:
            return None
        points = sorted(s for s in seconds if s > 0)
        if not points:
            return {"battle_id": battle_id, "frame_count": 0, "issues": ["没有任何帧落盘"]}
        duration = int(duration or points[-1])
        probe = list(points)
        if points[0] > 60:
            probe.insert(0, 0)
        if duration and points[-1] < duration - 30:
            probe.append(duration)
        gaps = [(b - a, a, b) for a, b in zip(probe, probe[1:]) if b > a]
        gap, gap_from, gap_to = max(gaps) if gaps else (0, 0, 0)
        issues = []
        if points[0] > 60:
            issues.append(f"开局缺失 {points[0]}s")
        if duration and points[-1] < duration - 30:
            issues.append(f"局末缺失 {duration - points[-1]}s")
        if gap > 30:
            issues.append(f"最长空档 {gap}s（{gap_from}–{gap_to}s）")
        return {"battle_id": battle_id, "frame_count": len(points), "first_sec": points[0],
                "last_sec": points[-1], "duration_sec": duration, "max_gap_sec": gap,
                "max_gap_from": gap_from, "max_gap_to": gap_to, "issues": issues}

    def _alert_lines(self, limit=6):
        path = self.runtime / "alerts.jsonl"
        try:
            with path.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - 12000))
                text = handle.read().decode("utf-8", errors="replace")
        except OSError:
            return []
        alerts = []
        for line in text.splitlines()[-limit:]:
            try:
                item = json.loads(line)
            except ValueError:
                continue
            title = str(item.get("title") or "")
            message = str(item.get("message") or "")
            alerts.append({"at": item.get("at"), "text": f"{title}：{message}".strip("：")})
        return alerts

    @staticmethod
    def _ping_health(port) -> dict | None:
        """Ask the local collector health socket (immune to file-lock staleness)."""
        try:
            port = int(port or 0)
        except (TypeError, ValueError):
            return None
        if not port:
            return None
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.6) as sock:
                sock.sendall(b"PING\n")
                sock.settimeout(0.6)
                data = sock.recv(512)
            payload = json.loads(data.decode("utf-8") or "{}")
            return payload if isinstance(payload, dict) else None
        except (OSError, ValueError):
            return None

    def collection_status(self):
        """Read-only acquisition status for the local panel (no ownership assumed)."""
        status = self._read_json(self.runtime / "collector_status.json")
        monitor = self._read_json(self.root / "data/realtime/monitor_status.json")
        health = self._read_json(self.runtime / "health.json")
        lease = self._read_json(self.runtime / "collector_lease.json")
        live_health = self._ping_health(lease.get("health_port"))
        state = str(status.get("state") or monitor.get("state") or "")
        if live_health:
            state = str(live_health.get("state") or state)
        battle_id = status.get("battle_id")
        if live_health:
            battle_id = live_health.get("battle_id") or battle_id
        minute = None
        try:
            source_sec = (live_health or {}).get("source_time_sec") or status.get("source_time_sec")
            if source_sec:
                minute = round(float(source_sec) / 60.0, 1)
            elif monitor.get("minute") is not None:
                minute = round(float(monitor["minute"]), 1)
        except (TypeError, ValueError):
            pass
        hb = self._age(status.get("updated_at"))
        poll = self._age(status.get("last_poll_at"))
        if live_health:
            # The socket answered: the process is alive even if the status file
            # is currently held by antivirus.
            hb = 0.0
            try:
                poll_epoch = float(live_health.get("last_poll_epoch") or 0)
            except (TypeError, ValueError):
                poll_epoch = 0.0
            if poll_epoch:
                poll = max(0.0, datetime.now().timestamp() - poll_epoch)
        snap = health.get("snapshot_age_sec")
        if snap is None:
            snap = self._snapshot_age(battle_id)
        source_status = status.get("source_status")
        live = bool(battle_id) and (state in {"live", "running", "polling"} or source_status == 1)
        labels = {"live": "采集中", "running": "采集中", "polling": "采集中",
                  "waiting_start": "等待开赛", "waiting_battle": "局间等待",
                  "waiting_schedule": "等待赛程", "waiting_next_match": "等待下一场",
                  "day_complete": "今日结束", "starting": "启动中",
                  "api_error": "接口异常", "error": "采集异常", "stopped": "已停止"}
        label = labels.get(state, state or "未知")
        severity = "idle"
        issue = ""
        if state in {"error", "stopped"}:
            severity, label = "error", "采集异常"
            issue = str(status.get("message") or monitor.get("message") or "")
        elif state == "api_error" and hb is not None and hb <= 30 and poll is not None and poll <= 30:
            # A transient official blip (or a pre-created battle that has no
            # data yet) is not a collector failure; keep it amber.
            severity, label = "warning", "接口抖动"
            issue = "官方接口暂时无数据，采集器在重试"
        elif live and (hb is None or hb > 30):
            severity, label = "error", "采集中断"
            issue = f"心跳 {round(hb) if hb is not None else '?'} 秒未更新"
        elif live and (poll is None or poll > 30):
            severity, label = "error", "采集循环停滞"
            issue = f"轮询 {round(poll) if poll is not None else '?'} 秒未更新"
        elif live and (snap is None or snap > 30):
            severity, label = "warning", "数据延迟"
            issue = f"官方源约 {round(snap) if snap is not None else '?'} 秒未推进"
        elif live:
            severity, label = "ok", "采集中"
        elif state in {"waiting_start", "waiting_battle", "waiting_schedule",
                       "waiting_next_match", "day_complete"}:
            severity, label = "idle", label
        elif hb is not None and hb > 30:
            severity, label = "error", "采集进程无心跳"
            issue = f"心跳 {round(hb)} 秒未更新"
        match = status.get("match") or monitor.get("match") or ""
        if live_health and live_health.get("match"):
            match = str(live_health.get("match"))
        match_text = match
        for suffix in (" · 未开始", " · 进行中", " · 已结束"):
            match_text = match_text.replace(suffix, "")
        if live:
            summary = (f"{label} · {match_text} · {minute or 0:.1f} 分钟"
                       if match_text else f"{label} · {minute or 0:.1f} 分钟")
            if snap is not None:
                summary += f" · 快照 {round(snap)} 秒前"
        else:
            summary = f"{label} · {match_text}" if match_text else label
        leader_pid = status.get("pid")
        peers = {}
        for role in ("primary", "standby"):
            peer = self._read_json(self.runtime / f"peer_{role}.json")
            if peer:
                peers[role] = {"pid": peer.get("pid"), "state": peer.get("state"),
                               "mutex": peer.get("mutex"), "updated_at": peer.get("updated_at")}
        takeover = self._read_json(self.runtime / "freshness_watchdog.json")
        takeover_at = takeover.get("acted_at")
        takeover_age = self._age(takeover_at)
        duration = None
        try:
            if status.get("source_time_sec"):
                duration = int(float(status["source_time_sec"]))
        except (TypeError, ValueError):
            pass
        current_cov = self._frame_coverage(battle_id, duration) if battle_id else None
        day = datetime.now().strftime("%Y-%m-%d")
        report = self._read_json(self.root / "reports" / f"live_coverage_{day}.json")
        battles = dict(report.get("battles") or {}) if isinstance(report.get("battles"), dict) else {}
        if current_cov:
            battles[str(battle_id)] = current_cov
        interruptions = []
        if issue:
            interruptions.append({"at": datetime.now().isoformat(timespec="seconds"),
                                  "text": f"{label}：{issue}"})
        if takeover_at and takeover_age is not None and takeover_age < 86400:
            problems = "；".join(takeover.get("problems") or [])
            interruptions.append({"at": takeover_at,
                                  "text": f"自动接管（原进程 {takeover.get('killed_pid')}）{problems}"})
        for bid, row in battles.items():
            for gap in (row.get("issues") or []):
                interruptions.append({"at": row.get("checked_at") or day, "text": f"{bid}: {gap}"})
        alert_titles = set()
        for item in self._alert_lines():
            age = self._age(item.get("at"))
            if age is not None and age > 43200:
                continue
            title_key = str(item.get("text") or "").split("：", 1)[0]
            if title_key in alert_titles:
                continue
            if "单局数据有缺口" in title_key:
                # Covered by the per-battle coverage row below; avoid duplicates.
                continue
            alert_titles.add(title_key)
            interruptions.append(item)
        interruptions.sort(key=lambda item: str(item.get("at") or ""), reverse=True)
        seen = set()
        unique = []
        for item in interruptions:
            key = (item.get("at"), item.get("text"))
            if key in seen:
                continue
            seen.add(key)
            unique.append(item)
        meta = []
        if leader_pid:
            meta.append(f"主 {leader_pid}")
        for role, peer in peers.items():
            if peer.get("pid") and peer.get("pid") != leader_pid:
                meta.append(f"备 {peer.get('pid')}")
        if status.get("model_name"):
            meta.append(f"模型 {status.get('model_name')}")
        if takeover_at:
            meta.append(f"最近接管 {str(takeover_at)[11:19]}")
        return {"state": state, "label": label, "severity": severity, "issue": issue,
                "summary": summary, "match": match, "battle_id": battle_id,
                "minute": minute, "heartbeat_age_sec": hb, "poll_age_sec": poll,
                "snapshot_age_sec": snap, "last_saved_at": status.get("last_saved_at"),
                "leader_pid": leader_pid, "peers": peers, "meta": " · ".join(meta),
                "last_takeover": ({"at": takeover_at, "problems": takeover.get("problems") or []}
                                  if takeover_at else None),
                "today": {"date": day, "battles": battles, "games": len(battles),
                          "with_gaps": sum(1 for row in battles.values() if row.get("issues"))},
                "current_coverage": current_cov,
                "interruptions": unique[:6],
                "checked_at": datetime.now().isoformat(timespec="seconds")}

    def status(self):
        with self.lock:
            states = {name: {"running": p.poll() is None, "pid": p.pid, "exit_code": p.poll()}
                      for name, p in self.children.items()}
            if states and any(not state["running"] for state in states.values()):
                # A partial pipeline must never be presented as healthy.
                if any(state["exit_code"] not in (None, 0) for state in states.values()):
                    self.error = "采集或导出程序异常退出，请查看日志。"
                elif any(state["running"] for state in states.values()):
                    self.error = "部分程序已退出，实时链路不完整。请先停止再重新启动。"
            if states and not any(state["running"] for state in states.values()):
                self._release()
            live = self.site / "assets/live.js"
            updated = datetime.fromtimestamp(live.stat().st_mtime, timezone.utc).isoformat() if live.exists() else None
            report = {}
            try:
                sources = [self.root / "data/realtime/monitor_status.json"]
                if self.private:
                    sources.append(self.runtime / "collector_status.json")
                sources = [path for path in sources if path.is_file()]
                if sources:
                    report = json.loads(max(sources, key=lambda path: path.stat().st_mtime).read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                pass
            record_age = None
            record_current = False
            try:
                updated_at = datetime.fromisoformat(report["updated_at"]).timestamp()
                record_age = max(0, datetime.now().timestamp() - updated_at)
                record_current = bool(self.started_at) and updated_at >= datetime.fromisoformat(self.started_at).timestamp() - 2
            except (KeyError, ValueError, TypeError):
                pass
            return {"mode": self.mode, "league": self.league, "started_at": self.started_at,
                    "model_found": bool(self.model_files()), "processes": states,
                    "external_collector": self.external_collector(),
                    "running": bool(states) and all(s["running"] for s in states.values()),
                    "error": self.error, "live_updated_at": updated,
                    "collector_record": {k: report.get(k) for k in ("state", "message", "updated_at", "match_id", "battle_id")},
                    "record_age_seconds": record_age, "record_from_current_run": record_current,
                    "collection": self.collection_status(),
                    "logs": {name: self._tail(name) for name in sorted(self.log_names)}}

    def start(self, mode="auto", league=None):
        with self.lock:
            if mode == "auto":
                league = self.default_league()
                mode = "predict" if self.model_files() else "collect"
            if mode not in ("collect", "predict") or not isinstance(league, str) or not league.isascii() or not league.isdigit() or not 1 <= len(league) <= 12 or int(league) <= 0:
                raise ValueError("请选择有效模式并填写数字赛事 ID。")
            if any(p.poll() is None for p in self.children.values()):
                raise ValueError("已有本面板启动的程序正在运行，请先停止。")
            if self.external_collector():
                raise ValueError("检测到其他终端运行的采集程序，请先在原终端停止后再使用本面板。")
            if mode == "predict" and not self.model_files():
                raise ValueError("未找到模型。请先选择“仅采集”，按 README 训练并验证模型后再启动实时预测。")
            # Check dependencies with the actual worker interpreter, without importing models.
            check = subprocess.run([self.python(), "-c", "import importlib.util,json; print(json.dumps([n for n in ['requests','pandas','numpy','joblib','sklearn','scipy'] if importlib.util.find_spec(n) is None]))"],
                                   capture_output=True, text=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if check.returncode or json.loads(check.stdout or "[]"):
                raise ValueError("采集环境缺少依赖，请先按 README 在项目环境中安装 requirements.txt。")
            self.stop()
            self._claim()
            self.mode, self.league = mode, league
            self.started_at = datetime.now(timezone.utc).isoformat()
            self.error = ""
            env = dict(os.environ, KPL_SITE_DIR=str(self.site), KPL_DATA_ROOT=str(self.root), PYTHONIOENCODING="utf-8")
            env["PYTHONPATH"] = str(self.source) + os.pathsep + env.get("PYTHONPATH", "")
            try:
                for name, command in self.commands(mode, league).items():
                    handle = (self.runtime / f"web-{name}.log").open("ab")
                    self.handles[name] = handle
                    self.log_names.add(name)
                    handle.write(f"\n--- {self.started_at} {mode} league={league} ---\n".encode())
                    handle.flush()
                    self.children[name] = subprocess.Popen(command, cwd=self.root, env=env, stdin=subprocess.DEVNULL,
                        stdout=handle, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except Exception:
                self.stop()
                raise
            return self.status()

    def stop(self):
        with self.lock:
            for process in self.children.values():
                if process.poll() is None:
                    process.terminate()
            for process in self.children.values():
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for handle in self.handles.values():
                handle.close()
            self.children.clear()
            self.handles.clear()
            self._release()
            self.error = ""
            return self.status()

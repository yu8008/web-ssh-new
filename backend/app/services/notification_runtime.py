"""SSH-target observer for already running CLIs. Standard library, Python 3.8+.

Only metadata crosses the separate SSH channel. Never writes to the terminal,
reads keystrokes, guesses from silence, or forwards transcript contents.
"""
from __future__ import annotations

import hashlib
from itertools import islice
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import time

IDENTIFIER = re.compile(r"[a-zA-Z0-9_-]{1,80}\Z")
ROOT = Path.home() / ".local/share/webssh-gateway"


def process_info(pid, proc=Path("/proc")):
    try:
        folder = proc / str(pid)
        if folder.stat().st_uid != os.getuid():
            return None
        fields = (folder / "stat").read_text().rsplit(")", 1)[1].split()
        argv = (folder / "cmdline").read_bytes().decode(errors="replace").split("\0")[:-1]
        comm = (folder / "comm").read_text().strip()
        app = "codex" if comm == "codex" or any(Path(arg).name in {"codex", "codex.js"} for arg in argv[:2]) else "claude" if comm == "claude" or any(Path(arg).name in {"claude", "claude.js"} for arg in argv[:2]) else None
        if any(arg in {"app-server", "daemon", "exec", "-p", "--print"} for arg in argv[1:]):
            app = None
        environment = {}
        for item in ((folder / "environ").read_bytes().split(b"\0") if app else []):
            key, _, value = item.partition(b"=")
            if key in {b"CODEX_HOME", b"CLAUDE_CONFIG_DIR", b"HOME"}:
                environment[key.decode()] = value.decode(errors="replace")
        cwd = os.readlink(folder / "cwd")
        script = os.path.abspath(os.path.join(cwd, argv[1])) if len(argv) > 1 and Path(argv[0]).name in {"node", "nodejs", "bun"} else None
        for index, arg in enumerate(argv[:-1]):
            if arg in {"-C", "--cd"}:
                cwd = os.path.abspath(os.path.join(cwd, argv[index + 1]))
        return {"pid": int(pid), "parent": int(fields[1]), "group": int(fields[2]),
                "foreground": int(fields[5]), "identity": str(pid) + ":" + fields[19],
                "app": app, "argv": argv, "cwd": cwd, "env": environment,
                "executable": os.readlink(folder / "exe"), "tty": os.readlink(folder / "fd/0"),
                "version_command": [str(folder / "exe"), script] if script else [str(folder / "exe")]}
    except (OSError, ValueError, IndexError):
        return None


def descendants(pid, processes):
    result = {pid}
    while True:
        added = {p for p, item in processes.items() if item["parent"] in result} - result
        if not added:
            return result
        result.update(added)


def anchor_pid(options, processes):
    if options.get("tmux") and options.get("target"):
        result = subprocess.run([options["tmux"], "display-message", "-p", "-t", options["target"], "#{pane_pid}"], capture_output=True, text=True, timeout=5)
        return int(result.stdout.strip()) if result.returncode == 0 else 0
    if options.get("pid"):
        return int(options["pid"])
    # A regular SSH terminal and this exec channel share an sshd ancestor.
    pid = os.getpid()
    for _ in range(12):
        item = processes.get(pid)
        if not item:
            return 0
        if Path(item["executable"]).name.startswith("sshd"):
            candidates = [p for p in descendants(pid, processes) if processes[p]["tty"].startswith("/dev/pts/")]
            terminals = {processes[p]["tty"] for p in candidates}
            return next((p for p in candidates if processes[p]["parent"] == pid), candidates[0] if candidates and len(terminals) == 1 else 0) if len(terminals) == 1 else 0
        pid = item["parent"]
    return 0


def rollout_metadata(path, home):
    try:
        path = path.resolve()
        if os.path.commonpath([str(path), str(home.resolve() / "sessions")]) != str(home.resolve() / "sessions"):
            return None
        with path.open("rb") as stream:
            first = stream.readline(1024 * 1024)
        record = json.loads(first)
        meta = record.get("payload", {})
        session_id = meta.get("id") or meta.get("session_id")
        foreground = meta.get("source") == "cli" or (meta.get("originator") == "codex-tui" and meta.get("thread_source") == "user")
        if record.get("type") != "session_meta" or not foreground or not isinstance(session_id, str) or not IDENTIFIER.fullmatch(session_id):
            return None
        return {"id": session_id, "path": str(path), "cwd": str(meta.get("cwd", ""))[:512], "modified_at": path.stat().st_mtime}
    except (OSError, ValueError, TypeError):
        return None


def candidate_titles(candidates, home):
    """Optional human-readable thread metadata; never reads message tables."""
    if not candidates:
        return
    try:
        import sqlite3
    except ImportError:
        return
    for database in islice(home.glob("state_*.sqlite"), 4):
        connection = None
        try:
            connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.1)
            connection.execute("PRAGMA query_only=ON")
            placeholders = ",".join("?" for _ in candidates)
            for session_id, title in connection.execute("SELECT id, title FROM threads WHERE id IN (" + placeholders + ")", list(candidates)):
                if session_id in candidates and isinstance(title, str):
                    candidates[session_id]["title"] = title[:200]
        except (sqlite3.Error, OSError):
            pass
        finally:
            if connection:
                connection.close()


def discover(options, proc=Path("/proc")):
    processes = {}
    for entry in proc.iterdir():
        if entry.name.isdigit():
            info = process_info(entry.name, proc)
            if info:
                processes[info["pid"]] = info
    anchor = anchor_pid(options, processes)
    children = descendants(anchor, processes) if anchor else set()
    clis = [item for pid, item in processes.items() if pid in children and item["app"] and item["group"] == item["foreground"]]
    clis = [item for item in clis if not any(other["pid"] != item["pid"] and other["pid"] in descendants(item["pid"], processes) for other in clis)]
    if len(clis) != 1:
        return {"state": "not_found" if not clis else "ambiguous_process", "capabilities": {}, "candidates": []}
    cli = clis[0]
    result = {key: cli[key] for key in ("app", "pid", "identity", "cwd", "executable")}
    result.update({"state": "observing", "capabilities": {}, "candidates": [], "config": {}})
    variable = "CODEX_HOME" if cli["app"] == "codex" else "CLAUDE_CONFIG_DIR"
    home = Path(cli["env"].get(variable) or str(Path(cli["env"].get("HOME", str(Path.home()))) / (".codex" if cli["app"] == "codex" else ".claude")))
    if not home.is_absolute():
        home = Path(cli["cwd"]) / home
    result["config"] = {variable: str(home)}
    result["version_command"] = cli["version_command"]
    if cli["app"] != "codex":
        return result
    owned = descendants(cli["pid"], processes)
    candidates = {}; direct = set()
    # Open rollout descriptors are bounded and exclude archived/unrelated logs.
    for pid, item in processes.items():
        if Path(item["executable"]).name != "codex" and item["app"] != "codex":
            continue
        try:
            for fd in islice((proc / str(pid) / "fd").iterdir(), 512):
                try:
                    raw = os.readlink(fd)
                except OSError:
                    continue
                if "/sessions/" not in raw or not raw.endswith(".jsonl"):
                    continue
                meta = rollout_metadata(Path(raw), home)
                if not meta:
                    continue
                if pid in owned:
                    direct.add(meta["id"])
                if pid in owned or os.path.realpath(meta["cwd"]) == os.path.realpath(cli["cwd"]):
                    candidates[meta["id"]] = meta
                if len(candidates) >= 64:
                    break
        except OSError:
            continue
    selected = next(iter(direct)) if len(direct) == 1 else None
    # An explicit resume UUID is also an unambiguous binding.
    if "resume" in cli["argv"]:
        position = cli["argv"].index("resume") + 1
        if position < len(cli["argv"]) and cli["argv"][position] in candidates:
            selected = cli["argv"][position]
    candidate_titles(candidates, home)
    result["candidates"] = sorted(candidates.values(), key=lambda item: item["id"])
    signature = hashlib.sha256(json.dumps([cli["identity"], sorted(candidates)]).encode()).hexdigest()
    result["signature"] = signature
    try:
        binding = json.loads((ROOT / "notification-bindings.json").read_text()).get(options["key"], {})
        if binding.get("signature") == signature and binding.get("id") in candidates:
            selected = binding["id"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    if selected:
        result.update({"state": "attached", "binding": selected, "capabilities": {"complete": "ready"}})
    elif candidates:
        result["state"] = "binding_required"
    else:
        result["state"] = "record_unavailable"
    return result


class RolloutTail:
    """Incremental bounded JSONL reader. Starting/reconnecting never replays."""
    def __init__(self, path, session_id):
        self.path = Path(path)
        self.session_id = session_id
        stat = self.path.stat()
        self.identity = (stat.st_dev, stat.st_ino)
        self.offset = stat.st_size
        self.pending = b""
        self.overflow = False

    def poll(self):
        stat = self.path.stat()
        if (stat.st_dev, stat.st_ino) != self.identity or stat.st_size < self.offset:
            raise ValueError("The bound session record was replaced")
        events = []
        with self.path.open("rb") as stream:
            stream.seek(self.offset)
            chunk = stream.read(256 * 1024)
        self.offset += len(chunk)
        for part in chunk.splitlines(keepends=True):
            if not self.overflow:
                self.pending += part
                if len(self.pending) > 1024 * 1024:
                    self.pending = b""; self.overflow = True
            if not part.endswith(b"\n"):
                continue
            raw = self.pending
            self.pending = b""; was_overflow = self.overflow; self.overflow = False
            if was_overflow:
                continue
            try:
                record = json.loads(raw)
                payload = record.get("payload", {})
                turn = payload.get("turn_id")
                if record.get("type") != "event_msg" or payload.get("type") != "task_complete" or not isinstance(turn, str) or not IDENTIFIER.fullmatch(turn):
                    continue
                identity = hashlib.sha256((self.session_id + ":" + turn + ":complete").encode()).hexdigest()[:32]
                events.append({"app": "codex", "kind": "complete", "id": identity})
            except (ValueError, TypeError, AttributeError):
                continue
        return events


def public_status(status):
    result = {key: value for key, value in status.items() if key not in {"config", "executable", "version_command", "signature"}}
    result["candidates"] = [{k: v for k, v in item.items() if k != "path"} for item in status.get("candidates", [])]
    return result


def emit(payload):
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def installed():
    try:
        manifest = json.loads((ROOT / "notifications.json").read_text())
        return isinstance(manifest, dict) and any(manifest.get(key) for key in ("codex", "claude", "codex_profiles", "claude_profiles"))
    except (OSError, ValueError):
        return False


def main(options):
    action = options.get("action", "watch")
    status = discover(options)
    if action == "probe":
        emit(status)
        return
    if action == "bind":
        selected = options.get("binding")
        if selected not in {item["id"] for item in status.get("candidates", [])} or options.get("signature") != status.get("signature"):
            raise ValueError("The running CLI changed; check the session again before binding")
        import fcntl
        with (ROOT / "notifications.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            path = ROOT / "notification-bindings.json"
            if path.is_symlink():
                raise ValueError("Refusing to replace a linked binding file")
            bindings = json.loads(path.read_text()) if path.exists() else {}
            bindings.pop(options["key"], None)
            bindings[options["key"]] = {"id": selected, "signature": status["signature"]}
            for key in list(bindings)[:-256]:
                del bindings[key]
            from tempfile import NamedTemporaryFile
            with NamedTemporaryFile(mode="w", dir=ROOT, delete=False) as stream:
                json.dump(bindings, stream); temporary = stream.name
            try:
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        emit({"bound": True})
        return
    previous = None; tail = None; bound = None; refresh = 0
    while True:
        now = time.monotonic()
        if now >= refresh:
            if not installed():
                return
            status = discover(options); refresh = now + 2
            binding = (status.get("identity"), status.get("binding"), status.get("signature"))
            if binding != bound:
                tail = None; bound = binding
                if status.get("binding"):
                    candidate = next(item for item in status["candidates"] if item["id"] == status["binding"])
                    try:
                        tail = RolloutTail(candidate["path"], candidate["id"])
                    except OSError:
                        status["state"] = "record_unavailable"; status["capabilities"] = {}
            public = public_status(status)
            comparable = public
            if public.get("state") == "attached":
                comparable = dict(public)
                comparable["candidates"] = [{key: value for key, value in item.items() if key != "modified_at"} for item in public["candidates"]]
            if comparable != previous:
                emit({"type": "status", "runtime": public}); previous = comparable
        if tail:
            try:
                events = tail.poll()
                if events:
                    current = discover(options)
                    if (current.get("identity"), current.get("binding"), current.get("signature")) == bound:
                        for event in events:
                            emit({"type": "event", "event": event})
                    else:
                        tail = None; bound = None; refresh = 0
            except (OSError, ValueError):
                tail = None; bound = None
                status.update({"state": "record_unavailable", "capabilities": {}})
                emit({"type": "status", "runtime": public_status(status)})
        # Closing the SSH channel's stdin stops the observer even when idle.
        readable, _, _ = select.select([sys.stdin], [], [], 0.2)
        if readable and not os.read(sys.stdin.fileno(), 1):
            return


if __name__ == "__main__":
    try:
        main(json.loads(sys.argv[1]))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        emit({"type": "status", "runtime": {"state": "unavailable", "capabilities": {}, "candidates": []}})

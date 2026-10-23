"""Standalone SSH-target installer and Claude hook; stdlib only.

Executed explicitly from the notification settings. Existing hooks and config
are retained. Nothing is installed by merely connecting a terminal.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

TUI = {"notifications": ["agent-turn-complete", "approval-requested", "async-question"],
       "notification_method": "osc9", "notification_condition": "always"}


def atomic_write(path, content):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink():
        raise ValueError("Refusing to replace a linked CLI configuration")
    fd, temporary = tempfile.mkstemp(prefix=".webssh-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
        os.chmod(temporary, path.stat().st_mode & 0o777 if path.exists() else 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def edit_tui(text, changes):
    import tomllib
    parsed = tomllib.loads(text)
    tui = parsed.get("tui", {})
    if not isinstance(tui, dict):
        raise ValueError("Codex tui must be a TOML table")
    lines = text.splitlines(keepends=True)
    output = []; table = ""; index = 0; found = False
    while index < len(lines):
        line = lines[index]
        header = re.match(r"^\s*(\[\[?.*?\]\]?)\s*(?:#.*)?$", line)
        if header:
            table = header[1]
            output.append(line)
            if table == "[tui]":
                found = True
                output.extend(f"{key} = {json.dumps(value)}\n" for key, value in changes.items() if value is not None)
            index += 1; continue
        pattern = r"^\s*(notifications|notification_method|notification_condition)\s*=" if table == "[tui]" else r"^\s*tui\.(notifications|notification_method|notification_condition)\s*=" if table == "" else None
        match = re.match(pattern, line) if pattern else None
        if match and match[1] in changes:
            value = line.split("=", 1)[1]
            index += 1
            while True:
                try:
                    tomllib.loads("value = " + value); break
                except tomllib.TOMLDecodeError:
                    if index >= len(lines):
                        raise ValueError("Could not safely edit the Codex notification setting")
                    value += lines[index]; index += 1
            continue
        output.append(line); index += 1
    if not found:
        if "tui" in parsed and not any(re.match(r"^\s*tui\.", line) for line in lines) and tui:
            raise ValueError("Use a [tui] table before configuring Codex notifications")
        if any(re.match(r"^\s*tui\.", line) for line in output):
            assignments = [f"tui.{key} = {json.dumps(value)}\n" for key, value in changes.items() if value is not None]
            output = assignments + output
        else:
            output.append("\n[tui]\n")
            output.extend(f"{key} = {json.dumps(value)}\n" for key, value in changes.items() if value is not None)
    result = "".join(output)
    tomllib.loads(result)
    return result


def paths():
    root = Path.home() / ".local" / "share" / "webssh-gateway"
    return root, Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml", Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))) / "settings.json"


def version(command):
    executable = shutil.which(command)
    if not executable:
        # SSH exec channels do not necessarily load the interactive PATH.
        for directory in (".local/bin", ".npm-global/bin", ".bun/bin", ".cargo/bin"):
            candidate = Path.home() / directory / command
            if candidate.is_file() and os.access(candidate, os.X_OK):
                executable = str(candidate)
                break
    if not executable:
        return None
    try:
        return subprocess.check_output([executable, "--version"], stderr=subprocess.DEVNULL, timeout=10).decode().strip()[:100]
    except (OSError, subprocess.SubprocessError):
        return None


def supports(value, minimum):
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", value or "")
    return bool(match and tuple(map(int, match.groups())) >= minimum)


def configure(action):
    root, codex_path, claude_path = paths()
    manifest_path = root / "notifications.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    result = {"codex_version": version("codex"), "claude_version": version("claude"),
              "installed": bool(manifest), "was_installed": bool(manifest), "notes": [], "agent_path": str(root / "notifications.py")}
    if action == "status":
        return result
    writes = {}
    def stage(path, content):
        writes[path] = content
    if action == "install":
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        agent = root / "notifications.py"
        stage(agent, Path(__file__).read_text())
        command = f"{shlex.quote(sys.executable)} {shlex.quote(str(agent))} hook"
        # Claude returns sequences via its own terminal writer, never /dev/tty.
        if result["claude_version"] and not supports(result["claude_version"], (2, 1, 306)):
            result["notes"].append("Claude Code automatic setup requires 2.1.306 or newer; this version was preserved")
        if supports(result["claude_version"], (2, 1, 306)):
            original = claude_path.read_text() if claude_path.exists() else "{}"
            config = json.loads(original)
            if not isinstance(config, dict) or not isinstance(config.get("hooks", {}), dict):
                raise ValueError("Invalid Claude hooks configuration")
            hooks = config.setdefault("hooks", {})
            specifications = {"Stop": None, "PermissionRequest": None, "PreToolUse": "^(AskUserQuestion|ExitPlanMode)$", "Notification": "^(permission_prompt|elicitation_dialog|elicitation_url_dialog)$", "PostToolUse": None, "UserPromptSubmit": None}
            if "claude" not in manifest:
                stage(root / "claude-settings.backup.json", original)
                manifest["claude"] = {"events_before": list(hooks), "had_hooks": "hooks" in json.loads(original), "file_existed": claude_path.exists()}
            for event, matcher in specifications.items():
                existing = hooks.setdefault(event, [])
                if not isinstance(existing, list):
                    raise ValueError("Invalid Claude hook event configuration")
                if not any(any(item.get("command") == command for item in group.get("hooks", [])) for group in existing):
                    group = {"hooks": [{"type": "command", "command": command, "timeout": 3}]}
                    if matcher:
                        group["matcher"] = matcher
                    existing.append(group)
            stage(claude_path, json.dumps(config, ensure_ascii=False, indent=2) + "\n")
            manifest["claude"].update({"path": str(claude_path), "command": command})
        if result["codex_version"] and not supports(result["codex_version"], (0, 163, 0)):
            result["notes"].append("Codex automatic setup requires 0.163.0 or newer; this version was preserved")
        if supports(result["codex_version"], (0, 163, 0)):
            try:
                import tomllib
                original = codex_path.read_text() if codex_path.exists() else ""
                parsed = tomllib.loads(original)
                if "codex" not in manifest:
                    stage(root / "codex-config.backup.toml", original)
                    before = parsed.get("tui", {})
                    manifest["codex"] = {"path": str(codex_path), "before": {key: before.get(key) for key in TUI}, "had_tui": "tui" in parsed, "file_existed": codex_path.exists()}
                stage(codex_path, edit_tui(original, TUI))
            except ImportError:
                result["notes"].append("Codex automatic setup requires Python 3.11 or newer")
        if not manifest:
            raise ValueError("No supported CLI found: use Codex 0.163.0+ or Claude Code 2.1.306+ in this SSH user's PATH")
        stage(manifest_path, json.dumps(manifest, indent=2))
        result["installed"] = True
        result["notes"].append("Codex: use new CLI sessions after initial setup. Review Claude hook changes in /hooks if requested.")
    elif action == "uninstall":
        codex = manifest.get("codex")
        if codex:
            import tomllib
            path = Path(codex["path"]); text = path.read_text()
            current = tomllib.loads(text).get("tui", {})
            changes = {key: codex["before"][key] for key, value in TUI.items() if current.get(key) == value}
            restored = edit_tui(text, changes)
            if not codex.get("had_tui", True) and not tomllib.loads(restored).get("tui"):
                restored = re.sub(r"(?m)^[ \t]*\[tui\][ \t]*(?:#[^\r\n]*)?\r?\n?", "", restored, count=1)
            stage(path, None if not codex.get("file_existed", True) and not restored.strip() else restored)
        claude = manifest.get("claude")
        if claude:
            path = Path(claude["path"]); config = json.loads(path.read_text())
            for event, groups in list(config.get("hooks", {}).items()):
                kept = []
                managed = False
                for group in groups:
                    if any(item.get("command") == claude["command"] for item in group.get("hooks", [])):
                        managed = True
                        group["hooks"] = [item for item in group["hooks"] if item.get("command") != claude["command"]]
                        if not group["hooks"]:
                            continue
                    kept.append(group)
                if managed and not kept and event not in claude.get("events_before", list(config["hooks"])):
                    del config["hooks"][event]
                else:
                    config["hooks"][event] = kept
            if not claude.get("had_hooks", True) and not config.get("hooks"):
                config.pop("hooks", None)
            stage(path, None if not claude.get("file_existed", True) and not config else json.dumps(config, ensure_ascii=False, indent=2) + "\n")
        stage(manifest_path, None)
        result["installed"] = False
    previous = {}; committed = []
    try:
        for path, content in writes.items():
            if path.is_symlink():
                raise ValueError("Refusing to replace a linked CLI configuration")
            previous[path] = path.read_text() if path.exists() else None
            if content is None:
                if path.exists(): path.unlink()
            else:
                atomic_write(path, content)
            committed.append(path)
    except Exception:
        for path in reversed(committed):
            if previous[path] is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, previous[path])
        raise
    return result


def hook():
    payload = json.loads(sys.stdin.read(1024 * 1024))
    event = payload.get("hook_event_name")
    tool = payload.get("tool_name", "")
    input_hash = hashlib.sha256(json.dumps(payload.get("tool_input"), sort_keys=True).encode()).hexdigest()
    cache = paths()[2].parent / "webssh-notification-state"
    state_path = cache / (hashlib.sha256(str(payload.get("session_id", "")).encode()).hexdigest() + ".json")
    try:
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
    except (ValueError, OSError):
        state = {}
    if event == "UserPromptSubmit" or (event == "PostToolUse" and state and (not state.get("tool") or (state.get("tool") == tool and state.get("input_hash") == input_hash))):
        state_path.unlink(missing_ok=True)
        return {}
    kind = None
    if event == "Stop" and not payload.get("background_tasks") and not payload.get("agent_id"):
        # A Stop hook may be vetoed by another Stop hook. Native program status
        # remains authoritative; disable this fallback when another configured
        # Stop handler could continue the agent instead of finishing the turn.
        root, _, user_settings = paths()
        try:
            manifest_path = root / "notifications.json"
            manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
            own_command = manifest.get("claude", {}).get("command")
            candidates = [user_settings]
            if isinstance(payload.get("cwd"), str):
                candidates.extend(Path(payload["cwd"]) / ".claude" / name for name in ("settings.json", "settings.local.json"))
            for candidate in candidates:
                if candidate.exists():
                    config = json.loads(candidate.read_text())
                    if any(handler.get("type") != "command" or not own_command or handler.get("command") != own_command for group in config.get("hooks", {}).get("Stop", []) for handler in group.get("hooks", [])):
                        return {}
        except (ValueError, OSError, TypeError):
            return {}
        kind = "complete"
    elif event == "PermissionRequest" or (event == "Notification" and payload.get("notification_type") == "permission_prompt"):
        if event == "PermissionRequest" and tool in {"AskUserQuestion", "ExitPlanMode"}:
            return {}  # The matching PreToolUse already identifies the question.
        kind = "approval"
    elif (event == "PreToolUse" and payload.get("tool_name") in {"AskUserQuestion", "ExitPlanMode"}) or (event == "Notification" and payload.get("notification_type") in {"elicitation_dialog", "elicitation_url_dialog"}):
        kind = "question"
    if not kind:
        return {}
    identity = payload.get("tool_use_id") or payload.get("turn_id")
    identifier = hashlib.sha256((str(payload.get("session_id")) + ":" + kind + ":" + str(identity)).encode()).hexdigest()[:32] if identity else uuid.uuid4().hex
    if event == "Notification" and state and time.time() - state.get("at", 0) < 86400:
        identifier = state["id"]; kind = state["kind"]
    elif kind != "complete":
        cache.mkdir(mode=0o700, parents=True, exist_ok=True)
        atomic_write(state_path, json.dumps({"id": identifier, "kind": kind, "tool": tool, "input_hash": input_hash, "at": time.time()}))
        entries = list(cache.glob("*.json"))
        if len(entries) > 256:
            for path in sorted(entries, key=lambda item: item.stat().st_mtime)[:len(entries) - 256]:
                if path != state_path: path.unlink(missing_ok=True)
    if kind == "complete":
        state_path.unlink(missing_ok=True)
    sequence = "\x1b]777;notify;WebSSH Gateway;" + json.dumps({"app": "claude", "kind": kind, "id": identifier}, separators=(",", ":")) + "\x07"
    return {"terminalSequence": sequence}


def relay(terminal):
    # tmux filters OSC 7501 unless it is explicitly wrapped for passthrough.
    # Observe only that small state envelope; retain no text or screenshots.
    if not re.fullmatch(r"/dev/(?:pts/\d+|tty[a-zA-Z0-9]+)", terminal):
        raise ValueError("Invalid tmux terminal")
    fd = os.open(terminal, os.O_WRONLY | os.O_NOCTTY | os.O_NONBLOCK)
    pattern = re.compile(rb"(?<!\x1b)\x1b\]7501;(?:\?|state=[^\x1b\x07]{1,1024})(?:\x07|\x1b\\)")
    pending = b""
    try:
        while True:
            chunk = sys.stdin.buffer.read1(65536)
            if not chunk:
                break
            data = pending + chunk
            consumed = 0
            for match in pattern.finditer(data):
                sequence = match.group()
                wrapped = b"\x1bPtmux;" + sequence.replace(b"\x1b", b"\x1b\x1b") + b"\x1b\\"
                try:
                    os.write(fd, wrapped)
                except BlockingIOError:
                    pass
                consumed = match.end()
            suffix = max(consumed, len(data) - 1100)
            if suffix and suffix < len(data) and data[suffix - 1:suffix + 1] == b"\x1b\x1b":
                suffix -= 1
            pending = data[suffix:]
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        if sys.argv[1] == "relay":
            relay(sys.argv[2])
        elif sys.argv[1] in {"install", "uninstall"}:
            import fcntl
            root = paths()[0]
            root.mkdir(mode=0o700, parents=True, exist_ok=True)
            with (root / "notifications.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                print(json.dumps(configure(sys.argv[1])))
        else:
            print(json.dumps(hook() if sys.argv[1] == "hook" else configure(sys.argv[1])))
    except Exception as error:
        if len(sys.argv) > 1 and sys.argv[1] == "hook":
            print("{}")  # Notification failures must never block the CLI.
        else:
            print(json.dumps({"error": str(error)})); sys.exit(1)

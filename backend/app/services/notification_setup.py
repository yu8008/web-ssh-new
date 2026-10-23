from __future__ import annotations

import base64
import json
from pathlib import Path
import shlex


async def configure_notifications(client, action: str):
    # Upload to a private temporary file so __file__ works on the SSH target.
    # No webhook credentials, inbound port, shell profile or model access needed.
    source = base64.b64encode(Path(__file__).with_name("notification_agent.py").read_bytes()).decode()
    runner = "import base64,json,os,subprocess,sys,tempfile\nif sys.version_info < (3,8):\n print(json.dumps({'error':'Python 3.8 or newer is required on the SSH target'})); sys.exit(1)\nf,p=tempfile.mkstemp(prefix='webssh-notify-',suffix='.py'); os.write(f,base64.b64decode(sys.argv[1])); os.close(f)\ntry: sys.exit(subprocess.call([sys.executable,p,sys.argv[2]]))\nfinally: os.unlink(p)"
    command = f"python3 -c {shlex.quote(runner)} {shlex.quote(source)} {shlex.quote(action)}"
    result = await client.run(command, check=False, timeout=40)
    try:
        payload = json.loads(str(result.stdout).strip())
    except (ValueError, TypeError) as error:
        raise RuntimeError("Python 3.8 or newer is required on the SSH target to configure CLI notifications") from error
    if result.exit_status != 0 or payload.get("error"):
        raise ValueError(payload.get("error", "CLI notification configuration failed"))
    return payload


async def configure_tmux_relay(session, action: str, agent_path: str = ""):
    binary = shlex.quote(session.tmux_binary_path)
    target = shlex.quote(f"{session.enhanced_fingerprint}:0.0")
    result = await session.client.run(f"{binary} display-message -p -t {target} '#{{pane_pipe}}|#{{@webssh-notification-relay}}|#{{pane_tty}}|#{{allow-passthrough}}|#{{@webssh-notification-passthrough-before}}'", check=False, timeout=10)
    fields = str(result.stdout).strip().split("|")
    if result.exit_status or len(fields) != 5:
        if action == "status":
            return {"active": False}
        raise RuntimeError("Could not inspect tmux notification relay")
    piped, owner, terminal, passthrough, previous = fields
    if action in {"check", "install"} and piped == "1" and owner != "webssh-v1":
        raise ValueError("This tmux pane already has an output pipe; it was preserved. Configure a separate pane for CLI notifications.")
    if action == "install":
        session_target = shlex.quote(session.enhanced_fingerprint)
        if passthrough not in {"on", "off", "all"}:
            raise RuntimeError("This tmux version does not support notification passthrough")
        if owner != "webssh-v1":
            explicit = await session.client.run(f"{binary} show-options -qv -t {session_target} allow-passthrough", check=False, timeout=10)
            previous = str(explicit.stdout).strip() or "inherit"
            await session.client.run(f"{binary} set-option -p -t {target} @webssh-notification-passthrough-before {shlex.quote(previous)}", check=False, timeout=10)
        desired = passthrough if passthrough in {"on", "all"} else "on"
        result = await session.client.run(f"{binary} set-option -t {session_target} allow-passthrough {desired}", check=False, timeout=10)
        if result.exit_status:
            raise RuntimeError("This tmux version does not support notification passthrough")
        if piped != "1":
            command = f"exec python3 {shlex.quote(agent_path)} relay {shlex.quote(terminal)}"
            result = await session.client.run(f"{binary} pipe-pane -O -t {target} {shlex.quote(command)}", check=False, timeout=10)
            if result.exit_status:
                restore = f"set-option -u -t {session_target} allow-passthrough" if previous == "inherit" else f"set-option -t {session_target} allow-passthrough {passthrough}"
                await session.client.run(f"{binary} {restore}", check=False, timeout=10)
                await session.client.run(f"{binary} set-option -pu -t {target} @webssh-notification-passthrough-before", check=False, timeout=10)
                raise RuntimeError("Could not start tmux notification relay")
        await session.client.run(f"{binary} set-option -p -t {target} @webssh-notification-relay webssh-v1", check=False, timeout=10)
        return {"active": True}
    elif action == "uninstall" and owner == "webssh-v1":
        await session.client.run(f"{binary} pipe-pane -t {target}", check=False, timeout=10)
        if passthrough == "on" and previous in {"on", "off", "all", "inherit"}:
            restore = f"set-option -u -t {shlex.quote(session.enhanced_fingerprint)} allow-passthrough" if previous == "inherit" else f"set-option -t {shlex.quote(session.enhanced_fingerprint)} allow-passthrough {previous}"
            await session.client.run(f"{binary} {restore}", check=False, timeout=10)
        await session.client.run(f"{binary} set-option -pu -t {target} @webssh-notification-relay", check=False, timeout=10)
        await session.client.run(f"{binary} set-option -pu -t {target} @webssh-notification-passthrough-before", check=False, timeout=10)
        return {"active": False}
    return {"active": piped == "1" and owner == "webssh-v1"}

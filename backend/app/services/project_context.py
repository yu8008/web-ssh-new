"""Serve project metadata independently of terminal output and input."""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
import shlex
import time

SOURCE = base64.b64encode(Path(__file__).with_name("project_runtime.py").read_bytes()).decode()
UNAVAILABLE = {"state": "unavailable", "cwd": None, "reason": "directory_unavailable"}


def runtime_command(**options):
    runner = "import base64;exec(compile(base64.b64decode(" + repr(SOURCE) + "),'<webssh-project>','exec'))"
    return f"python3 -c {shlex.quote(runner)} {shlex.quote(json.dumps(options))}"


async def execute(client, **options):
    result = await client.run(runtime_command(**options), check=False, timeout=8)
    if result.exit_status:
        return {**UNAVAILABLE, "reason": "probe_unavailable"}
    value = json.loads(str(result.stdout))
    if not isinstance(value, dict) or value.get("state") not in {"ready", "unavailable"}:
        raise ValueError("Invalid project response")
    if value["state"] == "ready" and not (isinstance(value.get("cwd"), str) and value["cwd"].startswith("/")):
        raise ValueError("Invalid project directory")
    return value


async def read_project(session, open_client, include_git=False):
    async with session.project_lock:
        cached = session.project_cache.get(include_git)
        if cached and time.monotonic() - cached[0] < 2:
            return cached[1]
        try:
            if session.enhanced_enabled and session.enhanced_fingerprint and session.tmux_binary_path:
                async with open_client() as client:
                    result = await execute(client, tmux=session.tmux_binary_path,
                                           target=f"{session.enhanced_fingerprint}:0.0", include_git=include_git)
            else:
                # The existing SSH transport identifies exactly this terminal's
                # sshd ancestry. Git itself runs on a separate connection.
                result = await execute(session.client)
                if include_git and result.get("cwd"):
                    async with open_client() as client:
                        metadata = await execute(client, action="git", cwd=result["cwd"], include_git=True)
                        result["git"] = metadata.get("git", {"state": "unavailable", "reason": "probe_unavailable"})
        except asyncio.CancelledError:
            raise
        except Exception:
            result = dict(UNAVAILABLE)
        result["checked_at"] = time.time()
        session.project_cache[include_git] = (time.monotonic(), result)
        return result

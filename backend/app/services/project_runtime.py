"""Read-only, bounded project probe, executed on the SSH target (Python 3.8+)."""
from __future__ import annotations

import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import time

LIMIT = 512 * 1024


class ProbeError(Exception):
    pass


def command(argv, deadline, cwd=None, limit=LIMIT):
    env = {**os.environ, "LC_ALL": "C", "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    chunks, size = [], 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProbeError("timeout")
                if not selector.select(min(remaining, .2)):
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise ProbeError("too_large")
                chunks.append(chunk)
        return process.wait(timeout=max(.01, deadline - time.monotonic())), b"".join(chunks)
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        process.stdout.close()


def process_info(pid, proc=Path("/proc")):
    try:
        folder = proc / str(pid)
        if folder.stat().st_uid != os.getuid():
            return None
        fields = (folder / "stat").read_text().rsplit(")", 1)[1].split()
        comm = (folder / "comm").read_text().strip()
        try:
            cwd = os.readlink(folder / "cwd")
        except OSError:
            cwd = None
        argv = (folder / "cmdline").read_bytes()[:16384].decode(errors="replace").split("\0")
        app = next((name for name in ("codex", "claude") if comm == name or
                    any(Path(arg).name in {name, name + ".js"} for arg in argv[:2])), None)
        if (app == "codex" and any(arg in {"exec", "app-server", "daemon"} for arg in argv[1:])) or (app == "claude" and any(arg in {"--print", "-p"} for arg in argv[1:])):
            app = None
        # Absolute Codex --cd is also valid when the CLI keeps a logical cwd.
        if app == "codex":
            for index, arg in enumerate(argv):
                value = argv[index + 1] if arg in {"-C", "--cd"} and index + 1 < len(argv) else arg[5:] if arg.startswith("--cd=") else ""
                if value.startswith("/") and os.path.isdir(value):
                    cwd = os.path.realpath(value)
                elif value and cwd:
                    try:
                        parent = proc / fields[1]
                        # If cwd already differs from the launcher, the CLI has
                        # applied its relative --cd. Never append it twice.
                        if parent.stat().st_uid == os.getuid() and os.readlink(parent / "cwd") == cwd:
                            target = os.path.join(cwd, value)
                            if os.path.isdir(target): cwd = os.path.realpath(target)
                    except OSError:
                        pass
        return {"pid": int(pid), "parent": int(fields[1]), "group": int(fields[2]),
                "tty": int(fields[4]), "foreground": int(fields[5]), "start": fields[19],
                "cwd": cwd, "app": app, "comm": comm}
    except (OSError, ValueError, IndexError):
        return None


def descendants(anchor, processes):
    result = {anchor: 0}
    while True:
        added = {pid: result[item["parent"]] + 1 for pid, item in processes.items()
                 if pid not in result and item["parent"] in result}
        if not added:
            return result
        result.update(added)


def ssh_anchor(processes, pid):
    for _ in range(16):
        parent = processes.get(pid)
        if not parent:
            break
        if parent["comm"].startswith("sshd"):
            children = descendants(pid, processes)
            candidates = [p for p in children if processes[p]["tty"] > 0]
            # Never bind to another terminal on a multiplexed connection.
            if len({processes[p]["tty"] for p in candidates}) == 1:
                return min(candidates, key=lambda p: (children[p], p))
            return 0
        pid = parent["parent"]
    return 0


def select_process(anchor, processes):
    root = processes.get(anchor)
    if not root:
        return None
    children = descendants(anchor, processes)
    active = [processes[p] for p in children if processes[p]["group"] == root["foreground"]]
    cli = [item for item in active if item["app"]]
    # Native CLI children outrank a node launcher; tool subprocesses do not.
    if cli:
        return max(cli, key=lambda item: children[item["pid"]])
    return next((item for item in active if item["pid"] == root["foreground"]), root)


def context(options, deadline, proc=Path("/proc")):
    anchor = 0
    tmux = options.get("tmux") and options.get("target")
    if tmux:
        code, data = command([options["tmux"], "display-message", "-p", "-t", options["target"], "#{pane_pid}"], deadline)
        if code == 0 and data.strip().isdigit():
            anchor = int(data.strip())
    processes = {}
    if proc.is_dir():
        for folder in proc.iterdir():
            if time.monotonic() >= deadline or len(processes) >= 8192:
                raise ProbeError("timeout")
            if folder.name.isdigit():
                item = process_info(folder.name, proc)
                if item:
                    processes[item["pid"]] = item
    anchor = anchor or ssh_anchor(processes, os.getpid())
    chosen = select_process(anchor, processes)
    if chosen:
        fresh = process_info(chosen["pid"], proc)
        if not fresh or fresh["start"] != chosen["start"]:
            return {"state": "unavailable", "cwd": None, "reason": "process_changed"}
        cwd = fresh["cwd"]
        if cwd and cwd.startswith("/") and not cwd.endswith(" (deleted)"):
            return {"state": "ready", "cwd": cwd, "source": "process", "app": fresh["app"]}
    if tmux:
        code, data = command([options["tmux"], "display-message", "-p", "-t", options["target"], "#{pane_current_path}"], deadline)
        path = os.fsdecode(data[:-1] if data.endswith(b"\n") else data)
        if code == 0 and path.startswith("/"):
            return {"state": "ready", "cwd": path, "source": "tmux", "app": None}
    return {"state": "unavailable", "cwd": None, "reason": "directory_unavailable"}


def parse_status(data):
    result = {"branch": None, "oid": None, "upstream": None, "ahead": 0, "behind": 0,
              "changed_files": 0, "untracked_files": 0, "conflicted_files": 0, "files": []}
    records = iter(data.split(b"\0"))
    for raw in records:
        line = os.fsdecode(raw)
        if line.startswith("# branch."):
            name, _, value = line.partition(" ")[2].partition(" ")
            if name == "branch.head": result["branch"] = value
            elif name == "branch.oid": result["oid"] = value
            elif name == "branch.upstream": result["upstream"] = value
            elif name == "branch.ab":
                ahead, behind = value.split()
                result.update(ahead=int(ahead[1:]), behind=int(behind[1:]))
            continue
        kind = line[:1]
        if kind not in {"1", "2", "u", "?"}: continue
        if kind == "?":
            path, status = line[2:], "??"
            result["untracked_files"] += 1
        else:
            fields = line.split(" ", {"1": 8, "2": 9, "u": 10}[kind])
            path, status = fields[-1], fields[1]
            result["changed_files"] += 1
            if kind == "u": result["conflicted_files"] += 1
            if kind == "2": next(records, b"")  # Original rename path.
        if len(result["files"]) < 100:
            result["files"].append({"path": path, "status": status})
    return result


def parse_numstat(data):
    added = deleted = binary = 0
    records = iter(data.split(b"\0"))
    for raw in records:
        if not raw: continue
        a, d, path = raw.split(b"\t", 2)
        if a == b"-" or d == b"-": binary += 1
        else: added += int(a); deleted += int(d)
        if not path: next(records, b""); next(records, b"")  # Rename pair.
    return {"added_lines": added, "deleted_lines": deleted, "binary_files": binary}


def git_status(cwd, deadline):
    if not shutil.which("git"):
        return {"state": "unavailable", "reason": "git_missing"}
    prefix = ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"]
    def git(*args):
        return command(prefix + list(args), deadline, cwd=cwd)
    code, root = git("rev-parse", "--show-toplevel")
    if code:
        return {"state": "not_repository"}
    root = os.fsdecode(root[:-1] if root.endswith(b"\n") else root)
    # Always report the whole repository, including paths outside a nested cwd.
    cwd = root
    code, raw = git("status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=dirty")
    if code: raise ProbeError("git_error")
    result = parse_status(raw)
    unborn = result["oid"] == "(initial)"
    base = "HEAD"
    if unborn:
        code, raw = git("hash-object", "-t", "tree", "/dev/null")
        if code: raise ProbeError("git_error")
        base = raw.decode().strip()
    code, raw = git("diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--find-renames", "-l1000", "--ignore-submodules=dirty", base, "--")
    if code: raise ProbeError("git_error")
    result.update(parse_numstat(raw))
    code, raw = git("remote")
    if code: raise ProbeError("git_error")
    remotes = os.fsdecode(raw).splitlines()
    code, raw = git("for-each-ref", "--count=101", "--format=%(refname:short)%00%(symref)", "refs/heads/", "refs/remotes/")
    if code: raise ProbeError("git_error")
    branches = [line.split("\0", 1)[0] for line in os.fsdecode(raw).splitlines() if line.endswith("\0")]
    result.update(state="ready", root=root, remotes=remotes[:20], branches=branches[:100],
                  branches_truncated=len(branches) > 100, unborn=unborn,
                  detached=result["branch"] == "(detached)",
                  files_truncated=result["changed_files"] + result["untracked_files"] > len(result["files"]))
    return result


def probe(options):
    deadline = time.monotonic() + 6
    if options.get("action") == "git":
        result = {"state": "ready", "cwd": options["cwd"]}
    else:
        try:
            result = context(options, deadline)
        except (ProbeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
            return {"state": "unavailable", "cwd": None, "reason": str(error) if isinstance(error, ProbeError) else "directory_unavailable"}
    if options.get("include_git") and result.get("cwd"):
        try:
            result["git"] = git_status(result["cwd"], deadline)
        except (ProbeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
            result["git"] = {"state": "unavailable", "reason": str(error) if isinstance(error, ProbeError) else "git_error"}
    return result


if __name__ == "__main__":
    print(json.dumps(probe(json.loads(sys.argv[1]))))

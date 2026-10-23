from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

from app.services import project_runtime as runtime


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL).decode().strip()


@pytest.fixture
def repo(tmp_path):
    path = tmp_path / "project with spaces'; $(never-run)"; path.mkdir()
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Project test")
    git(path, "config", "user.email", "project@example.invalid")
    (path / "source.txt").write_text("first\nsecond\nthird\n")
    git(path, "add", "."); git(path, "commit", "-qm", "initial")
    return path


def status(repo):
    return runtime.git_status(str(repo), time.monotonic() + 10)


def test_working_tree_net_lines_include_staged_and_unstaged_without_double_counting(repo):
    (repo / "source.txt").write_text("first\nreplaced\nthird\nstaged\n")
    git(repo, "add", ".")
    (repo / "source.txt").write_text("first\nreplaced\nthird\nstaged\nworking\n")
    (repo / "untracked.txt").write_text("not counted\n" * 50)
    result = status(repo)
    assert (result["added_lines"], result["deleted_lines"]) == (3, 1)
    assert (result["changed_files"], result["untracked_files"]) == (1, 1)
    assert result["remotes"] == [] and result["branch"] == "main"
    assert result["files"][0] == {"path": "source.txt", "status": "MM"}
    # The probe must not change the index/stat cache or repository config.
    before = [(repo / ".git" / name).read_bytes() for name in ("index", "config")]
    assert status(repo) == result
    assert before == [(repo / ".git" / name).read_bytes() for name in ("index", "config")]


def test_staged_edits_reverted_in_worktree_have_zero_net_lines(repo):
    (repo / "source.txt").write_text("changed\n"); git(repo, "add", ".")
    (repo / "source.txt").write_text("first\nsecond\nthird\n")
    result = status(repo)
    assert result["changed_files"] == 1
    assert (result["added_lines"], result["deleted_lines"]) == (0, 0)


def test_rename_binary_deleted_and_newline_names(repo):
    git(repo, "mv", "source.txt", "renamed\tfile\n.txt")
    (repo / "binary.dat").write_bytes(b"\x00\x01\x02")
    git(repo, "add", ".")
    result = status(repo)
    assert result["changed_files"] == 2 and result["binary_files"] == 1
    assert (result["added_lines"], result["deleted_lines"]) == (0, 0)
    assert any(item["path"] == "renamed\tfile\n.txt" and item["status"].startswith("R") for item in result["files"])
    (repo / "renamed\tfile\n.txt").unlink()
    result = status(repo)
    assert result["deleted_lines"] == 3


def test_repository_root_from_nested_directory_and_configured_remote_without_fetch(repo):
    nested = repo / "nested"; nested.mkdir()
    git(repo, "remote", "add", "origin", "https://secret-token@example.invalid/repo.git")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "branch", "--set-upstream-to", "origin/main")
    (repo / "source.txt").write_text("new\n"); git(repo, "commit", "-qam", "next")
    result = status(nested)
    assert result["root"] == str(repo)
    assert result["remotes"] == ["origin"] and result["upstream"] == "origin/main"
    assert result["ahead"] == 1 and result["behind"] == 0
    assert "secret-token" not in str(result)
    assert "main" in result["branches"] and "origin/main" in result["branches"]


def test_unborn_detached_and_worktree_repositories(tmp_path, repo):
    fresh = tmp_path / "fresh"; fresh.mkdir(); git(fresh, "init", "-q", "-b", "empty")
    (fresh / "added.txt").write_text("a\nb\n"); git(fresh, "add", ".")
    first = status(fresh)
    assert first["unborn"] and first["branch"] == "empty" and first["added_lines"] == 2
    git(repo, "checkout", "--detach", "-q")
    assert status(repo)["detached"]
    worktree = tmp_path / "worktree"; git(repo, "worktree", "add", "-qb", "feature", str(worktree))
    assert status(worktree)["branch"] == "feature" and status(worktree)["root"] == str(worktree)


def test_conflicts_and_large_lists_keep_explicit_counts(repo):
    git(repo, "checkout", "-qb", "other")
    (repo / "source.txt").write_text("other\n"); git(repo, "commit", "-qam", "other")
    git(repo, "checkout", "-q", "main")
    (repo / "source.txt").write_text("main\n"); git(repo, "commit", "-qam", "main")
    subprocess.run(["git", "-C", str(repo), "merge", "other"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for n in range(110): (repo / f"new-{n}").touch()
    result = status(repo)
    assert result["conflicted_files"] == 1 and result["untracked_files"] == 110
    assert result["files_truncated"] and len(result["files"]) == 100


def test_no_git_no_repository_and_bounded_subprocess(tmp_path, monkeypatch):
    assert status(tmp_path)["state"] == "not_repository"
    with pytest.raises(runtime.ProbeError, match="too_large"):
        runtime.command([sys.executable, "-c", "print('x'*10000)"], time.monotonic() + 2, limit=100)
    start = time.monotonic()
    with pytest.raises(runtime.ProbeError, match="timeout"):
        runtime.command([sys.executable, "-c", "import time;time.sleep(10)"], time.monotonic() + .1)
    assert time.monotonic() - start < 2
    monkeypatch.setattr(runtime.shutil, "which", lambda name: None)
    assert status(tmp_path) == {"state": "unavailable", "reason": "git_missing"}


def process(proc, pid, parent, group, foreground, cwd, app="bash", tty=1, argv=None):
    folder = proc / str(pid); folder.mkdir(parents=True)
    fields = ["S", str(parent), str(group), "1", str(tty), str(foreground)] + ["0"] * 13 + [str(pid * 100)]
    (folder / "stat").write_text(f"{pid} ({app}) " + " ".join(fields))
    (folder / "comm").write_text(app)
    (folder / "cmdline").write_bytes(b"\0".join(x.encode() for x in (argv or [app])) + b"\0")
    (folder / "cwd").symlink_to(cwd)
    return folder


def test_foreground_cli_outweighs_shell_and_tool_child_directories(tmp_path):
    proc = tmp_path / "proc"
    process(proc, 1, 0, 1, 10, "/home")
    process(proc, 10, 1, 10, 10, "/project", "claude")
    process(proc, 11, 10, 10, 10, "/project/subdir")
    process(proc, 20, 1, 20, 10, "/unrelated", "codex")
    data = {pid: runtime.process_info(pid, proc) for pid in (1, 10, 11, 20)}
    assert runtime.select_process(1, data)["cwd"] == "/project"
    data[1]["foreground"] = 1
    assert runtime.select_process(1, data)["cwd"] == "/home"


def test_ssh_anchor_rejects_multiple_terminals_and_other_uid(tmp_path, monkeypatch):
    proc = tmp_path / "proc"
    process(proc, 1, 0, 1, 1, "/", "sshd", tty=0)
    process(proc, 10, 1, 10, 10, "/project", tty=42)
    process(proc, 20, 1, 20, 20, "/", "python3", tty=0)
    data = {pid: runtime.process_info(pid, proc) for pid in (1, 10, 20)}
    assert runtime.ssh_anchor(data, 20) == 10
    process(proc, 11, 1, 11, 11, "/foreign", tty=43)
    data[11] = runtime.process_info(11, proc)
    assert runtime.ssh_anchor(data, 20) == 0
    monkeypatch.setattr(os, "getuid", lambda: 999999)
    assert runtime.process_info(10, proc) is None


def test_tmux_fallback_and_codex_absolute_cd(tmp_path, monkeypatch):
    cwd = tmp_path / "actual project"; cwd.mkdir()
    proc = tmp_path / "proc"
    process(proc, 10, 0, 10, 10, "/home", "codex", argv=["codex", "--cd", str(cwd)])
    assert runtime.process_info(10, proc)["cwd"] == str(cwd)
    monkeypatch.setattr(runtime, "command", lambda args, *rest, **kwargs: (0, b"100\n" if args[-1] == "#{pane_pid}" else b"/fallback folder\n"))
    result = runtime.context({"tmux": "/tmux", "target": "exact:0.0"}, time.monotonic()+2, tmp_path/"no-proc")
    assert result["cwd"] == "/fallback folder" and result["source"] == "tmux"


def test_live_tmux_follows_existing_shell_then_foreground_cli_without_restart(repo, tmp_path):
    import shlex
    import shutil
    import uuid
    if sys.platform != "linux" or not shutil.which("tmux"):
        pytest.skip("Live process integration requires Linux and tmux")
    socket = "webssh-project-test-" + uuid.uuid4().hex
    base = ["tmux", "-L", socket, "-f", "/dev/null"]
    wrapper = tmp_path / "tmux-wrapper"
    wrapper.write_text("#!/bin/sh\nexec " + shlex.join(base) + ' "$@"\n'); wrapper.chmod(0o700)
    cli = tmp_path / "cli.py"
    cli.write_text("import ctypes,os,sys,time,subprocess\nctypes.CDLL(None).prctl(15,b'claude',0,0,0)\nos.chdir(sys.argv[1])\nsubprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],cwd='/tmp')\ntime.sleep(60)\n")
    options = {"tmux": str(wrapper), "target": "test:0.0", "include_git": True}
    try:
        subprocess.run(base + ["new-session", "-d", "-s", "test", "-c", str(tmp_path), "/bin/bash --noprofile --norc"], check=True)
        subprocess.run(base + ["send-keys", "-t", "test:0.0", "-l", "cd " + shlex.quote(str(repo))], check=True)
        subprocess.run(base + ["send-keys", "-t", "test:0.0", "Enter"], check=True)
        def await_result(app):
            stop = time.monotonic() + 5
            while time.monotonic() < stop:
                result = runtime.probe(options)
                if result.get("cwd") == str(repo) and result.get("app") == app: return result
                time.sleep(.05)
            raise AssertionError(result)
        assert await_result(None)["git"]["branch"] == "main"
        subprocess.run(base + ["send-keys", "-t", "test:0.0", "-l", shlex.join([sys.executable, str(cli), str(repo)])], check=True)
        subprocess.run(base + ["send-keys", "-t", "test:0.0", "Enter"], check=True)
        result = await_result("claude")
        assert result["git"]["branch"] == "main" and result["source"] == "process"
        # Also exercise the exact base64/JSON command sent over SSH.
        import json
        from app.services.project_context import runtime_command
        uploaded = json.loads(subprocess.check_output(shlex.split(runtime_command(**options)), timeout=10))
        assert uploaded["cwd"] == str(repo) and uploaded["git"]["branch"] == "main"
    finally:
        subprocess.run(base + ["kill-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def test_codex_profile_and_relative_cd_are_not_mistaken_for_print_mode(tmp_path):
    proc = tmp_path / "proc"; project = tmp_path / "project"; project.mkdir()
    process(proc, 1, 0, 1, 10, str(tmp_path))
    process(proc, 10, 1, 10, 10, str(tmp_path), "codex", argv=["codex", "-p", "profile", "-C", "project"])
    info = runtime.process_info(10, proc)
    assert info["app"] == "codex" and info["cwd"] == str(project)
    (proc / "10/cwd").unlink(); (proc / "10/cwd").symlink_to(project)
    assert runtime.process_info(10, proc)["cwd"] == str(project)

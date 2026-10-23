# WebSSH Gateway

> English document. 中文文档请见：[README.md](./README.md)

WebSSH Gateway is a browser-based SSH gateway for operations, development, and AI CLI workflows. Use terminal tools such as Codex and Claude Code alongside SSH connection management, file operations, and server monitoring.

One of its core capabilities is the persistent session design for long-running workloads. With enhanced sessions powered by `tmux`, background jobs can keep running even if the browser closes, the network briefly drops, or the page is refreshed. This is useful for long-lived scripts, AI coding workflows, scheduled data monitoring, log collection, and similar automation scenarios.

This repository focuses on terminal-history scrolling, large text selections, live light/dark themes, and notification sounds when a CLI finishes a turn or needs your input. Recent output from the same session and notification records can be viewed on another device.

The visual theme, “Gateway,” combines oversized typography, an original metallic sculpture, pointer-driven spring motion, and self-hosted fonts. The workspace provides session cards, connection filters, and a Resume work action. Sign-in, terminals, files, monitoring, settings, and logs share neutral charcoal/white surfaces, a restrained blue accent, and Lucide icons. Terminal backgrounds remain `#212121` in dark mode and `#ffffff` in light mode, with TUI panels and selections switching immediately. The sculpture stops animating when interaction settles, falls back to local artwork when graphics support is unavailable, and respects reduced-motion preferences.

[Quick Start](#quick-start) · [CLI Task Notifications](#cli-task-notifications) · [Architecture](./docs/ARCHITECTURE.en.md) · [Deployment](./docs/DEPLOYMENT.en.md)

## Project Preview

Screenshots show the current interface with demonstration data.

![WebSSH Gateway Sign-in](./docs/images/gateway-login.png)

![WebSSH Gateway Overview](./docs/images/gateway-workspace.png)
![WebSSH Gateway Dark Terminal](./docs/images/gateway-terminal.png)

![WebSSH Gateway Light Terminal](./docs/images/gateway-terminal-light.png)

## Mobile Experience

A dedicated mobile layout provides touch-friendly interactions for terminal work, file management, and system monitoring in phone browsers.

<img src="./docs/images/gateway-mobile-workspace.png" alt="Mobile Overview" width="320" style="max-width: 100%;" />
<img src="./docs/images/gateway-mobile-terminal.png" alt="Mobile Terminal" width="320" style="max-width: 100%;" />
<img src="./docs/images/gateway-mobile-files.png" alt="Mobile File Management" width="320" style="max-width: 100%;" />

## Key Features

- Latency details: click the gateway latency to inspect browser/gateway round trips, gateway/SSH command round trips, gateway reply queues, scheduling delays and browser output/render waits. These independent samples cannot be subtracted to obtain pure network latency. Scheduling delays show the 5-second maximum; hidden tabs are excluded from browser sampling.
- Per-viewer output acknowledgements bound the amount of unparsed data sent to a browser while allowing input and latency probes to continue. Legacy clients/servers remain compatible; update both sides for full diagnostics and flow control.
- Browser terminal with real-time WebSocket streaming
- AI CLI output handling: ordered transport and rendering batches, stable reading position during output, and reset followed by recent-history replay on reconnect
- Terminal selection and copy: drag to an edge to extend selection, with progressive acceleration while held at an edge and stable highlighting across complete redraws; `Ctrl+C` copies selected text and sends an interrupt without a selection; `Ctrl+Shift+C` / `Cmd+C` also copy. Settings control this browser's scrollback limit, defaulting to 10,000 lines.
- The terminal uses xterm 6 synchronized rendering with hardware WebGL and a DOM fallback. Wheel distance is reduced to 0.85× while retaining fractional trackpad movement. Cross-screen selection keeps its highlight visible and advances in small steps, aligned with complete terminal frames. Reading existing history preserves the viewport while new output continues to reach other devices.
- Live terminal themes: the browser adapts neutral TUI panel backgrounds and darkens colored and dim secondary text in light mode while applications such as Codex keep running. Existing content, selection highlights and new output follow the current theme.
- CLI task notifications: distinct completion and question/approval sounds, previews, volume controls, cross-session delivery, tab deduplication, and synchronized unread records. See [CLI Task Notifications](#cli-task-notifications) for setup and compatibility.
- Connection asset management with encrypted credentials
- Session lifecycle management with reconnect and notes
- Grouped session view: sessions can be grouped by connection/machine, with list/grouped view switching, persisted display preference, and machine status preview in group headers
- Enhanced persistent session design powered by `tmux`, with keepalive and auto-retry
- Minimal SSH server compatibility: enhanced session components automatically fall back to SSH stream upload when SFTP is unavailable, supporting environments such as OpenWrt and Dropbear
- Mobile-friendly experience for phone browsers with touch-first layouts and controls
- Mobile terminal selection copy: select and copy partial output using native touch selection, with the copy view opening near the current terminal viewport
- System monitoring for CPU, memory, network, process, and disk
- System log viewer from the session management page, showing recent backend process logs for troubleshooting login, session, and system API issues
- File management: browse, upload/download, rename, delete, chmod, and batch upload. The browser follows the current SSH session / foreground CLI directory, with a pause toggle. Directory following pauses during file dialogs, uploads, and downloads.
- Git project status: a desktop Git button below Files and a mobile Git tab show the current branch, configured remotes, changed files, line additions/deletions, untracked files, and conflicts. Missing remotes are shown explicitly. Queries run only while a project panel and the page are visible; they never type into the terminal or automatically commit, switch branches, or fetch/pull/push.
- Pasted image cache: Settings provides per-connection image lists, disk usage, expiration times, previews, downloads, deletion, and manual expiry cleanup. Retention defaults to 3 days with a 7-day option. A background worker cleans expired images at startup and hourly, even with no open terminal, and retries offline targets on subsequent checks. Older `/tmp/webssh-clipboard.*` images are supported; only cache images owned by the remote account are removed. Connections sharing an SSH account share its cache. Download images you want to keep; removing a saved connection prevents further Gateway cleanup through that connection.
- Security baseline: JWT auth, password policy, lockout policy, request-id logging

Directory and Git synchronization require Python 3.8+ on the SSH target; Git status also requires Git. Linux foreground-process metadata identifies the session directory, with tmux directory information available for enhanced sessions. Unresolved directories are reported as unavailable; manual file browsing remains available. Line totals are tracked working-tree changes against HEAD, with untracked and binary files labeled separately. Ahead/behind uses locally stored remote refs, without contacting the remote.

## Tech Stack

- Backend: FastAPI + SQLAlchemy + AsyncSSH + SQLite
- Frontend: React + TypeScript + Vite + TailwindCSS + xterm.js
- Deployment: Docker / Docker Compose

## CLI Task Notifications

### Notification Types

| Event | Notification |
| --- | --- |
| The main CLI session finishes its current turn | One short tone |
| A question, choice, or approval needs your input | Two short tones, with the source session shown |
| An intermediate command, tool, or subtask finishes | Does not announce completion of the main turn |
| A generic notification or bell from another terminal program | Optional; disabled by default |

“Turn finished” means the CLI ended its current response, rather than a guarantee that every operation succeeded. Detection uses CLI notification/state events, without guessing from conversation keywords, question marks, or a period without output.

### Initial Setup

1. Sign in and open a connected SSH terminal.
2. Open **Task notifications and sound** in the toolbar, then select **Enable sound and preview** to activate audio on this device.
3. Select **Configure CLI notifications** to configure Codex notifications and Claude hooks for the target SSH user. Setup backs up and merges existing settings; it does not restart running CLI programs.
4. Inspect the running CLI's integration status. Existing sessions can attach directly; when a shared Codex background process prevents an unambiguous mapping, select **Bind this session**. Claude can load new hooks while running; inspect them with `/hooks`.
5. Adjust completion sounds, question/approval sounds, volume, and **Only sound when away from this page**. New devices default to 60%; saved volume settings are preserved, with **Use recommended volume: 60%** available. Sound must be enabled explicitly; foreground and background alerts are allowed.

CLI configuration belongs to the SSH user on the target server. Sound preferences belong to the current device. Use **Check setup** to inspect integration and **Remove setup** to undo the managed configuration. To mute immediately, turn off **Play notification sounds**.

Setup records, configuration checks, and live-session verification are shown separately. Verified configuration does not prove the running session has emitted a notification; individual capabilities become verified after an actual event. Linux targets identify existing CLIs from the current terminal's processes. Codex completion can use explicit end-of-turn events appended to its existing session record; questions/approvals still need native waiting signals. Neither conversation text nor silence is used to guess. Attachment and reconnect start at the record's end without replaying historical alerts. Unreadable records and uncertain ownership are reported. After switching conversations in the same CLI, rebind if prompted.

### Automatic Setup Requirements

The versions below were exercised in isolated local CLI and tmux tests. Newer versions must retain compatible notification interfaces.

| Tool | Minimum version for automatic setup | SSH target requirements |
| --- | --- | --- |
| Codex CLI | 0.163.0 | Python 3.11+ to read and preserve TOML configuration |
| Claude Code | 2.1.306 | Python 3.8+ |
| Other CLIs | Depends on terminal notification/bell support | Generic alerts may not distinguish completion from questions |

Enhanced sessions configure tmux state forwarding. If a custom output pipe already exists, automatic setup stops and preserves it rather than overwriting it. Custom Stop/continuation hooks need separate verification; when other user/project Stop hooks are detected, completion relies on native end-of-turn status to avoid premature alerts.

### Records and Scope

- Notifications remain available when you switch sessions or visit the session management page. Select a notification to open its source session.
- The Gateway stores notifications and read state for synchronization between devices signed into the same account. Audio settings remain local to each device; browser tabs coordinate playback to avoid duplicate sounds for the same event.
- The inbox retains up to 200 notifications per account for seven days. Refreshing, reconnecting, and loading old records do not replay accumulated sounds.
- This retention applies only to notification records. Recent terminal output and browser scrollback keep their existing limits; seven-day terminal-output archiving has not been added.
- Keep the page open and running. Frozen browsers, sleeping/locked devices, closed pages, and disconnected gateway SSH transports cannot guarantee prompt playback. Background push and system desktop notifications are not implemented.

## Quick Start

> Security notice: before deployment, you must replace both `SECRET_KEY` and `INITIAL_ADMIN_PASSWORD` in `.env` with your own strong values. Never keep example/default values.

### Local Development

See [docs/DEPLOYMENT.en.md](./docs/DEPLOYMENT.en.md) for step-by-step setup.

### Build a Docker Image from This Repository

Build from this repository to include its terminal scrolling, theme, and task-notification changes.

```bash
git clone https://github.com/yu8008/web-ssh-new.git
cd web-ssh-new
cp .env.example .env

# Set your own SECRET_KEY and INITIAL_ADMIN_PASSWORD in .env before continuing.
docker build -t webssh-gateway:local .

docker run -d \
  --name webssh-gateway \
  --restart unless-stopped \
  -p 8080:8080 \
  --env-file .env \
  -v webssh-data:/data \
  webssh-gateway:local
```

Open `http://your-server:8080`, sign in as `admin` with the configured initial password, and change it when prompted on first login.

Existing deployments should retain their original `.env` and data volume, then rebuild and update the container through their existing deployment process. A GitHub push or frontend build alone does not update a running Docker container.

The [beibeizi/websshgateway image](https://hub.docker.com/r/beibeizi/websshgateway) referenced by the original documentation is maintained upstream and may not contain this repository's additions. See [docs/DEPLOYMENT.en.md](./docs/DEPLOYMENT.en.md) for the full development/deployment guide; use the source-build instructions above for these changes.

## Documentation

- Architecture: [docs/ARCHITECTURE.en.md](./docs/ARCHITECTURE.en.md)
- Development & Deployment: [docs/DEPLOYMENT.en.md](./docs/DEPLOYMENT.en.md)
- Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Chinese Readme: [README.md](./README.md)

## License

Licensed under [Apache-2.0](./LICENSE).

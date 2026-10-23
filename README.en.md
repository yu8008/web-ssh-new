# WebSSH Gateway Community Edition

> English document. 中文文档请见：[README.md](./README.md)

WebSSH Gateway is a browser-based SSH gateway for operations and development teams. It provides SSH connection management, terminal sessions, system monitoring, and file operations in a single web interface.

One of its core capabilities is the persistent session design for long-running workloads. With enhanced sessions powered by `tmux`, background jobs can keep running even if the browser closes, the network briefly drops, or the page is refreshed. This is useful for long-lived scripts, AI coding workflows, scheduled data monitoring, log collection, and similar automation scenarios.

## Project Preview

![WebSSH Gateway Overview](./docs/images/preview-overview.png)
![WebSSH Gateway Terminal and File Manager](./docs/images/preview-terminal.png)

## Mobile Experience

A dedicated mobile layout provides touch-friendly interactions for terminal work, file management, and system monitoring in phone browsers.

<img src="./docs/images/mobile-overview.jpg" alt="Mobile Overview" width="320" style="max-width: 100%;" />
<img src="./docs/images/mobile-terminal.jpg" alt="Mobile Terminal" width="320" style="max-width: 100%;" />
<img src="./docs/images/mobile-fileManagement.jpg" alt="Mobile File Management" width="320" style="max-width: 100%;" />
<img src="./docs/images/mobile-systemStatus.jpg" alt="Mobile System Status" width="320" style="max-width: 100%;" />

## Community Edition Notice

- This repository is the **Community Edition (CE)** of WebSSH Gateway.
- CE will remain open source and focused on core SSH gateway capabilities.
- There is an intention to explore a paid development direction in the future, but detailed scope and release timeline are **TBD**.
- The boundary between CE and any potential paid edition is **TBD**. CE remains independently deployable.

## Key Features

- Latency details: click the gateway latency to inspect browser/gateway round trips, gateway/SSH command round trips, gateway reply queues, scheduling delays and browser output/render waits. These independent samples cannot be subtracted to obtain pure network latency. Scheduling delays show the 5-second maximum; hidden tabs are excluded from browser sampling.
- Per-viewer output acknowledgements bound the amount of unparsed data sent to a browser while allowing input and latency probes to continue. Legacy clients/servers remain compatible; update both sides for full diagnostics and flow control.

- Browser terminal with real-time WebSocket streaming
- AI CLI output handling: ordered transport and rendering batches, stable reading position during output, and reset followed by recent-history replay on reconnect
- Terminal selection and copy: drag to an edge to extend selection, with progressive acceleration while held at an edge and stable highlighting across complete redraws; `Ctrl+C` copies selected text and sends an interrupt without a selection; `Ctrl+Shift+C` / `Cmd+C` also copy. Settings control this browser's scrollback limit, defaulting to 10,000 lines.
- The terminal uses xterm 6 synchronized rendering with hardware WebGL and a DOM fallback. Wheel distance is reduced to 0.85× while retaining fractional trackpad movement. Cross-screen selection keeps its highlight visible and advances in small steps, aligned with complete terminal frames. Reading existing history preserves the viewport while new output continues to reach other devices.
- Live terminal themes: the browser adapts neutral TUI panel backgrounds and darkens colored and dim secondary text in light mode while applications such as Codex keep running. Existing content, selection highlights and new output follow the current theme.
- Connection asset management with encrypted credentials
- Session lifecycle management with reconnect and notes
- Grouped session view: sessions can be grouped by connection/machine, with list/grouped view switching, persisted display preference, and machine status preview in group headers
- Enhanced persistent session design powered by `tmux`, with keepalive and auto-retry
- Minimal SSH server compatibility: enhanced session components automatically fall back to SSH stream upload when SFTP is unavailable, supporting environments such as OpenWrt and Dropbear
- Mobile-friendly experience for phone browsers with touch-first layouts and controls
- Mobile terminal selection copy: select and copy partial output using native touch selection, with the copy view opening near the current terminal viewport
- System monitoring for CPU, memory, network, process, and disk
- System log viewer from the session management page, showing recent backend process logs for troubleshooting login, session, and system API issues
- File management: browse, upload/download, rename, delete, chmod, batch upload
- Pasted image cache: Settings provides per-connection image lists, disk usage, expiration times, previews, downloads, deletion, and manual expiry cleanup. Retention defaults to 3 days with a 7-day option. A background worker cleans expired images at startup and hourly, even with no open terminal, and retries offline targets on subsequent checks. Older `/tmp/webssh-clipboard.*` images are supported; only cache images owned by the remote account are removed. Connections sharing an SSH account share its cache. Download images you want to keep; removing a saved connection prevents further Gateway cleanup through that connection.
- Security baseline: JWT auth, password policy, lockout policy, request-id logging

## Tech Stack

- Backend: FastAPI + SQLAlchemy + AsyncSSH + SQLite
- Frontend: React + TypeScript + Vite + TailwindCSS + xterm.js
- Deployment: Docker / Docker Compose

## Quick Start

> Security notice: before deployment, you must replace both `SECRET_KEY` and `INITIAL_ADMIN_PASSWORD` in `.env` with your own strong values. Never keep example/default values.

### Local Development

See [docs/DEPLOYMENT.en.md](./docs/DEPLOYMENT.en.md) for step-by-step setup.

### Docker Deployment

Docker Hub image: `https://hub.docker.com/r/beibeizi/websshgateway`

Quick start example (note: both `SECRET_KEY` and `INITIAL_ADMIN_PASSWORD` below are examples and must be replaced in your own deployment):

```bash
docker run -d -p 8080:8080 \
  -e SECRET_KEY="67e457b4eab14012b34382b3d634f297" \
  -e INITIAL_ADMIN_PASSWORD="ChangeMe123" \
  beibeizi/websshgateway:latest
```

```bash
export DOCKER_IMAGE=beibeizi/websshgateway:latest

# You can also build a local image yourself
docker build -t webssh-gateway:community .
docker run -d \
  --name webssh-gateway \
  -p 8080:8080 \
  --env-file .env \
  -v webssh-data:/data \
  ${DOCKER_IMAGE:-webssh-gateway:community}
```

## Documentation

- Architecture: [docs/ARCHITECTURE.en.md](./docs/ARCHITECTURE.en.md)
- Development & Deployment: [docs/DEPLOYMENT.en.md](./docs/DEPLOYMENT.en.md)
- Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Chinese Readme: [README.md](./README.md)

## License

Licensed under [Apache-2.0](./LICENSE).

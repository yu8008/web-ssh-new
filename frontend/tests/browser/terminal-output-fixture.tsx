import React from "react";
import { createRoot } from "react-dom/client";
import "xterm/css/xterm.css";
import "../../src/index.css";
import { useTerminalSocket } from "../../src/pages/terminal/useTerminalSocket";
import { TerminalLoading } from "../../src/pages/terminal/TerminalLoading";
import { TerminalLatencyStatus } from "../../src/pages/terminal/TerminalLatencyStatus";

const parameters = new URLSearchParams(location.search);
localStorage.setItem("token", "fixture-token");
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => String(input).endsWith("/sessions/pipeline")
  ? Promise.resolve(new Response(JSON.stringify({ id: "pipeline", enhanced_enabled: false }), { status: 200 }))
  : originalFetch(input, init);

class FixtureSocket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  protocol: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  inputs: string[] = [];
  constructor(_url: string, protocol: string | string[]) {
    super();
    this.protocol = parameters.has("legacy") ? "" : parameters.has("v1") ? "webssh.output.v1" : Array.isArray(protocol) ? protocol[0] : protocol;
    sockets.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(data: string) {
    this.inputs.push(data);
    const frame = JSON.parse(data);
    if (frame.type === "ping" && !parameters.has("noPong")) {
      setTimeout(() => {
        if (this.readyState === 1) this.receive(JSON.stringify({ type: "pong", ping_id: frame.ping_id,
          ...(parameters.has("diagnostics") ? { gateway_queue_ms: 6, gateway_loop_lag_ms: 3, gateway_queued_chars: 120, gateway_inflight_chars: 32 } : {}) }));
      }, Number(parameters.get("pingDelay") || "0"));
    }
  }
  close(code = 1000) {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, wasClean: true }));
  }
  receive(data: string) { this.onmessage?.({ data }); }
}
const sockets: FixtureSocket[] = [];
window.WebSocket = FixtureSocket as unknown as typeof WebSocket;
let parseWrites = 0;
let measuredTerminal: unknown;

export function Harness() {
  const enhancedSessionRef = React.useRef(false);
  const [copied, setCopied] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const t = React.useCallback((zh: string) => zh, []);
  const noop = React.useCallback(() => {}, []);
  const state = useTerminalSocket({ sessionId: "pipeline", t, enhancedSessionRef, push: setNotice, reportNetworkHint: noop, clearNetworkHint: noop, setCurrentDir: noop, onCopyRequest: setCopied });
  React.useEffect(() => {
    const term = state.terminalInstance.current;
    if (term && measuredTerminal !== term) {
      measuredTerminal = term;
      const write = term.write.bind(term);
      term.write = (data, callback) => { parseWrites++; write(data, callback); };
    }
    window.pipeline = {
      frame: (frame) => sockets.at(-1)!.receive(typeof frame === "string" ? frame : JSON.stringify(frame)),
      screen: () => {
        const term = state.terminalInstance.current!;
        const buffer = term.buffer.active;
        return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "").join("\n");
      },
      top: () => {
        const buffer = state.terminalInstance.current!.buffer.active;
        return buffer.getLine(buffer.viewportY)?.translateToString(true);
      },
      scroll: (line) => state.terminalInstance.current!.scrollToLine(line),
      select: () => state.terminalInstance.current!.select(0, 0, 12),
      selectAll: () => state.terminalInstance.current!.selectAll(),
      selected: () => state.getSelectionText(),
      inputs: () => sockets.at(-1)!.inputs.map((data) => JSON.parse(data)),
      count: () => sockets.length,
      history: () => state.terminalInstance.current!.options.scrollback,
      dimensions: () => ({ rows: state.terminalInstance.current!.rows, cols: state.terminalInstance.current!.cols }),
      writes: () => parseWrites,
      pasteMode: () => state.terminalInstance.current!.modes.bracketedPasteMode,
      diagnostics: () => state.terminalDiagnostics,
      disconnect: (retryable = false) => sockets.at(-1)!.close(retryable ? 1012 : 1000),
    };
  }, [state]);
  return <>
    <div id="connection">{state.connectionState}</div>
    <div id="latency">{state.terminalLatencyMs ?? "unknown"}</div>
    <div id="painted">{String(state.hasRenderedOutput)}</div>
    <TerminalLatencyStatus {...state} t={t} targetLatencyMs={24} browserLatencyMs={80} />
    <div id="notice">{notice}</div>
    <div style={{ position: "relative", height: "65vh", minHeight: 200, padding: 12 }}>
      <div ref={state.terminalRef} style={{ height: "100%", width: "100%" }} />
      <TerminalLoading state={{ ...state, t }} />
    </div>
    <button id="reconnect" onClick={state.handleReconnect}>Reconnect</button>
    <button id="copy" onClick={() => setCopied(state.getSelectionText())}>Copy</button>
    <pre id="copied">{copied}</pre>
  </>;
}

declare global {
  interface Window {
    pipeline: {
      frame(frame: string | object): void;
      screen(): string; top(): string | undefined; scroll(line: number): void;
      select(): void; selectAll(): void; selected(): string; inputs(): Array<{ type: string; data?: string; ack_seq?: number; epoch?: string }>;
      count(): number; history(): number | undefined; dimensions(): { rows: number; cols: number };
      writes(): number;
      pasteMode(): boolean;
      diagnostics(): import("../../src/pages/terminal/terminalDiagnostics").TerminalDiagnostics | null;
      disconnect(retryable?: boolean): void;
    };
  }
}
createRoot(document.getElementById("root")!).render(<Harness />);

import React from "react";
import { createRoot } from "react-dom/client";
import "xterm/css/xterm.css";
import "../../src/index.css";
import { useTerminalSocket } from "../../src/pages/terminal/useTerminalSocket";
import { TerminalLoading } from "../../src/pages/terminal/TerminalLoading";

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
  constructor(_url: string, protocol: string) {
    super();
    this.protocol = parameters.has("legacy") ? "" : protocol;
    sockets.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(data: string) { this.inputs.push(data); }
  close(code = 1000) {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, wasClean: true }));
  }
  receive(data: string) { this.onmessage?.({ data }); }
}
const sockets: FixtureSocket[] = [];
window.WebSocket = FixtureSocket as unknown as typeof WebSocket;

export function Harness() {
  const enhancedSessionRef = React.useRef(false);
  const [copied, setCopied] = React.useState("");
  const t = React.useCallback((zh: string) => zh, []);
  const noop = React.useCallback(() => {}, []);
  const state = useTerminalSocket({ sessionId: "pipeline", t, enhancedSessionRef, push: noop, reportNetworkHint: noop, clearNetworkHint: noop, setCurrentDir: noop, onCopyRequest: setCopied });
  React.useEffect(() => {
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
    };
  }, [state]);
  return <>
    <div id="connection">{state.connectionState}</div>
    <div id="painted">{String(state.hasRenderedOutput)}</div>
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
      select(): void; selectAll(): void; selected(): string; inputs(): Array<{ type: string; data?: string }>;
      count(): number; history(): number | undefined; dimensions(): { rows: number; cols: number };
    };
  }
}
createRoot(document.getElementById("root")!).render(<Harness />);

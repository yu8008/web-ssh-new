import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { attachTerminalSelection } from "../../src/pages/terminal/terminalSelection";

const element = (id: string) => document.getElementById(id)!;
const parameters = new URLSearchParams(location.search);
const shell = parameters.get("mode") === "shell";
const delay = Number(parameters.get("delay") || "50");
const chunkDelay = Number(parameters.get("chunkDelay") || "20");
const synchronized = parameters.has("synchronized");
let offset = Number(parameters.get("offset") || "20");
let wheelCount = 0;
let finished = 0;
const inputs: string[] = [];
const terminal = new Terminal({ cols: 64, rows: 12, fontSize: 16, scrollback: 500, theme: { background: "#111827" } });
terminal.open(element("terminal"));
const selection = attachTerminalSelection(terminal, element("terminal"), {
  onChange: (text) => { element("selection").textContent = text; },
  onFinish: () => { element("finished").textContent = String(++finished); },
  onLimit: () => { element("selection").dataset.limit = "true"; },
});
const render = (unrelated = false) => {
  const lines = unrelated
    ? Array.from({ length: 12 }, (_, index) => `Repainted unrelated row ${index}`)
    : ["Fixed header", ...Array.from({ length: 10 }, (_, index) => `Output ${String(offset + index).padStart(3, "0")} 中文 😀`), "Fixed footer"];
  // Split a remote repaint into two asynchronous batches to exercise SSH chunks.
  const halfway = Math.floor(lines.length / 2);
  const first = (synchronized ? "\x1b[?2026h" : "") + "\x1b[H" + lines.slice(0, halfway).map((text) => "\x1b[2K" + text).join("\r\n") + "\r\n";
  const second = lines.slice(halfway).map((text) => "\x1b[2K" + text).join("\r\n") + (synchronized ? "\x1b[?2026l" : "");
  terminal.write(first);
  setTimeout(() => terminal.write(second), chunkDelay);
};
terminal.onData((data) => {
  inputs.push(data);
  element("inputs").textContent = JSON.stringify(inputs);
  if (parameters.has("clickRepaint") && /^\x1b\[<0;.*M$/.test(data)) render(true);
  const wheel = /\x1b\[<(64|65);/.exec(data);
  if (!wheel) return;
  element("wheels").textContent = String(++wheelCount);
  const nextOffset = Math.max(0, Math.min(90, offset + (wheel[1] === "64" ? -2 : 2)));
  if (nextOffset !== offset) {
    offset = nextOffset;
    setTimeout(render, delay);
  }
});
element("copy").addEventListener("click", () => { element("copied").textContent = selection.getText(); });
element("repaint").addEventListener("click", () => render(true));
element("dispose").addEventListener("click", () => selection.dispose());
if (shell) {
  terminal.write(Array.from({ length: 100 }, (_, index) => `Shell row ${String(index).padStart(3, "0")}`).join("\r\n"), () => {
    terminal.scrollToLine(30);
    element("terminal").dataset.ready = "true";
  });
} else {
  const bufferMode = parameters.get("buffer") === "normal" ? "" : "\x1b[?1049h";
  terminal.write(bufferMode + "\x1b[?1002h\x1b[?1006h", () => {
    render();
    setTimeout(() => { element("terminal").dataset.ready = "true"; }, chunkDelay + 30);
  });
}

import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { attachTerminalSelection } from "../../src/pages/terminal/terminalSelection";
import { configureTerminalRendering } from "../../src/pages/terminal/terminalRendering";
import { createTerminalInputWriter } from "../../src/pages/terminal/terminalInput";
import { SelectionTranscript } from "../../src/pages/terminal/selectionTranscript";
import { attachTerminalWheel } from "../../src/pages/terminal/terminalWheel";
import { createTerminalOutput } from "../../src/pages/terminal/terminalOutput";
import { attachTerminalViewport } from "../../src/pages/terminal/terminalViewport";
import { attachTerminalShortcuts } from "../../src/pages/terminal/terminalShortcuts";

const element = (id: string) => document.getElementById(id)!;
const parameters = new URLSearchParams(location.search);
const shell = parameters.get("mode") === "shell";
const delay = Number(parameters.get("delay") || "50");
const chunkDelay = Number(parameters.get("chunkDelay") || "20");
const synchronized = parameters.has("synchronized");
let offset = Number(parameters.get("offset") || "20");
let wheelCount = 0;
let finished = 0;
let changes = 0;
let textReads = 0;
const readText = SelectionTranscript.prototype.getText;
SelectionTranscript.prototype.getText = function () {
  element("selection").dataset.textReads = String(++textReads);
  return readText.call(this);
};
const inputs: string[] = [];
const packets: string[] = [];
const terminal = new Terminal({
  cols: Number(parameters.get("cols") || "64"), rows: Number(parameters.get("rows") || "12"),
  fontSize: 16, scrollback: 500, theme: { background: "#111827" },
});
terminal.open(element("terminal"));
if (parameters.get("renderer") !== "dom") configureTerminalRendering(terminal);
const viewport = attachTerminalViewport(terminal, element("terminal"));
const output = createTerminalOutput({
  write: (data, done) => terminal.write(data, done),
  beforeWrite: viewport.capture, afterWrite: viewport.restore,
  onOverflow: () => { throw new Error("Fixture output overflow"); },
});
const writeOutput = (data: string) => output.enqueue(data);
const selection = attachTerminalSelection(terminal, element("terminal"), {
  onChange: (selected) => {
    element("selection").dataset.changes = String(++changes);
    element("selection").dataset.selected = String(selected);
    if (!selected) element("selection").textContent = "";
  },
  onFinish: () => {
    element("selection").textContent = selection.getText();
    element("finished").textContent = String(++finished);
  },
  onLimit: () => { element("selection").dataset.limit = "true"; },
});
const render = (unrelated = false) => {
  const lines = unrelated
    ? Array.from({ length: terminal.rows }, (_, index) => `Repainted unrelated row ${index}`)
    : ["Fixed header", ...Array.from({ length: terminal.rows - 2 }, (_, index) => {
      const text = `Output ${String(offset + index).padStart(3, "0")} 中文 😀`;
      const colored = parameters.has("dense") ? Array.from({ length: Math.max(0, terminal.cols - 20) }, (_, col) =>
        `\x1b[38;5;${32 + col % 180}m${String.fromCharCode(97 + col % 26)}`).join("") + "\x1b[0m" : "";
      return text + colored;
    }), "Fixed footer"];
  // Split a remote repaint into two asynchronous batches to exercise SSH chunks.
  const halfway = Math.floor(lines.length / 2);
  const first = (synchronized ? "\x1b[?2026h" : "") + "\x1b[H" + lines.slice(0, halfway).map((text) => "\x1b[2K" + text).join("\r\n") + "\r\n";
  const second = lines.slice(halfway).map((text) => "\x1b[2K" + text).join("\r\n") + (synchronized ? "\x1b[?2026l" : "");
  writeOutput(first);
  setTimeout(() => writeOutput(second), chunkDelay);
};
const inputWriter = createTerminalInputWriter(window, (data) => {
  packets.push(data);
  element("packets").textContent = JSON.stringify(packets);
  const reports = data.match(/\x1b\[<\d+;\d+;\d+[Mm]/g) ?? [data];
  for (const data of reports) {
    inputs.push(data);
    element("inputs").textContent = JSON.stringify(inputs);
    if (parameters.has("clickRepaint") && /^\x1b\[<0;.*M$/.test(data)) render(true);
    const wheel = /\x1b\[<(64|65);/.exec(data);
    if (!wheel) continue;
    element("wheels").textContent = String(++wheelCount);
    const nextOffset = Math.max(0, Math.min(Number(parameters.get("maxOffset") || "90"), offset + (wheel[1] === "64" ? -2 : 2)));
    if (nextOffset !== offset) {
      offset = nextOffset;
      setTimeout(render, delay);
    }
  }
});
terminal.onData(inputWriter.write);
attachTerminalShortcuts(terminal, selection.getText, (text) => { element("copied").textContent = text; });
const wheelController = attachTerminalWheel(terminal, element("terminal"), () => parameters.has("enhanced"), inputWriter.write);
element("copy").addEventListener("click", () => { element("copied").textContent = selection.getText(); });
element("repaint").addEventListener("click", () => render(true));
element("dispose").addEventListener("click", () => { selection.dispose(); inputWriter.dispose(); wheelController.dispose(); output.dispose(); viewport.dispose(); });
if (shell) {
  terminal.write(Array.from({ length: 100 }, (_, index) => `Shell row ${String(index).padStart(3, "0")}`).join("\r\n"), () => {
    const duration = terminal.options.smoothScrollDuration;
    terminal.options.smoothScrollDuration = 0;
    terminal.scrollToLine(Number(parameters.get("scrollLine") || "30"));
    terminal.options.smoothScrollDuration = duration;
    requestAnimationFrame(() => { element("terminal").dataset.ready = "true"; });
  });
} else {
  const bufferMode = parameters.get("buffer") === "normal" ? "" : "\x1b[?1049h";
  terminal.write(bufferMode + "\x1b[?1002h\x1b[?1006h", () => {
    render();
    setTimeout(() => { element("terminal").dataset.ready = "true"; }, chunkDelay + 30);
  });
}

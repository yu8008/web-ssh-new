import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { attachTerminalSelection } from "../../src/pages/terminal/terminalSelection";
import { configureTerminalRendering } from "../../src/pages/terminal/terminalRendering";
import { disposeTerminal } from "../../src/pages/terminal/terminalLifecycle";
import { createTerminalInputWriter } from "../../src/pages/terminal/terminalInput";
import { SelectionTranscript } from "../../src/pages/terminal/selectionTranscript";
import { attachTerminalWheel } from "../../src/pages/terminal/terminalWheel";
import { createTerminalOutput } from "../../src/pages/terminal/terminalOutput";
import { attachTerminalViewport } from "../../src/pages/terminal/terminalViewport";
import { attachTerminalShortcuts } from "../../src/pages/terminal/terminalShortcuts";
import { darkTerminalTheme } from "../../src/pages/terminal/terminalUtils";

const element = (id: string) => document.getElementById(id)!;
const parameters = new URLSearchParams(location.search);
const shell = parameters.get("mode") === "shell";
const delay = Number(parameters.get("delay") || "50");
const chunkDelay = Number(parameters.get("chunkDelay") || "20");
const synchronized = parameters.has("synchronized") && parameters.get("synchronized") !== "0";
let offset = Number(parameters.get("offset") || "20");
let wheelCount = 0;
let dropped = false;
let lastAcceptedWheel = -Infinity;
let responsePending = false;
let responseOffset = offset;
let holdResponses = parameters.has("holdAfter");
const heldReplies: Array<() => void> = [];
const scheduleResponse = (reply: () => void, milliseconds: number) => {
  if (holdResponses && wheelCount > Number(parameters.get("holdAfter"))) heldReplies.push(reply);
  else setTimeout(reply, milliseconds);
};
let finished = 0;
let changes = 0;
let textReads = 0;
let selectionDraws = 0;
const readText = SelectionTranscript.prototype.getText;
SelectionTranscript.prototype.getText = function () {
  element("selection").dataset.textReads = String(++textReads);
  return readText.call(this);
};
const inputs: string[] = [];
const packets: string[] = [];
const terminal = new Terminal({
  cols: Number(parameters.get("cols") || "64"), rows: Number(parameters.get("rows") || "12"),
  ...(parameters.has("appFont") ? { fontSize: 15, lineHeight: 1.3, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" } : { fontSize: 16 }),
  scrollback: Number(parameters.get("shellLines") || "500"), theme: parameters.has("styled") ? darkTerminalTheme : { background: "#111827" },
});
terminal.open(element("terminal"));
const rendering = parameters.get("renderer") !== "dom" ? configureTerminalRendering(terminal, {
  preferWebgl: parameters.get("renderer") === "webgl" ? true : parameters.get("renderer") === "canvas" ? false : undefined,
}) : undefined;
const viewport = attachTerminalViewport(terminal, element("terminal"));
const output = createTerminalOutput({
  write: (data, done) => terminal.write(data, done),
  beforeWrite: viewport.capture, afterWrite: viewport.restore,
  onOverflow: () => { throw new Error("Fixture output overflow"); },
});
const writeOutput = (data: string) => output.enqueue(data);
const select = terminal.select.bind(terminal);
terminal.select = (...args) => {
  element("selection").dataset.draws = String(++selectionDraws);
  select(...args);
};
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
  flushInput: () => inputWriter.flush(),
});
const repaints: Array<{ first: string; second: string; offset: number }> = [];
let repainting = false;
const drainRepaints = () => {
  if (repainting || !repaints.length) return;
  repainting = true;
  const repaint = repaints.shift()!;
  writeOutput(repaint.first);
  setTimeout(() => output.enqueue(repaint.second, () => {
    element("terminal").dataset.offset = String(repaint.offset);
    repainting = false;
    drainRepaints();
  }), chunkDelay);
};
const render = (unrelated = false, renderOffset = offset) => {
  const style = (text: string) => parameters.has("styled")
    ? `\x1b[1;4;${parameters.has("dim") ? "2;" : ""}38;2;96;165;250;48;5;236m${text}\x1b[0m` : text;
  const footer = parameters.has("dynamicFooter")
    ? [`Status ${renderOffset >= Number(parameters.get("dynamicFrom") ?? 40) ? renderOffset : "idle"}`, `Prompt ${renderOffset >= Number(parameters.get("dynamicFrom") ?? 40) ? "running" : "ready"}`, "Fixed footer"]
    : ["Fixed footer"];
  const lines = unrelated
    ? Array.from({ length: terminal.rows }, (_, index) => `Repainted unrelated row ${index}`)
    : ["Fixed header", ...Array.from({ length: terminal.rows - 1 - footer.length }, (_, index) => {
      const absolute = renderOffset + index;
      const number = parameters.get("repeat") === "boundary"
        ? absolute % 10 === 4 || absolute % 10 === 5 ? absolute - 2 : absolute
        : parameters.has("repeat") && absolute % 10 === 4 ? absolute - 6 : absolute;
      const text = `Output ${String(number).padStart(3, "0")} 中文 😀`;
      const colored = parameters.has("dense") ? Array.from({ length: Math.max(0, terminal.cols - 20) }, (_, col) =>
        `\x1b[38;5;${32 + col % 180}m${String.fromCharCode(97 + col % 26)}`).join("") + "\x1b[0m" : "";
      return style(text) + colored;
    }), ...footer.map((text) => parameters.has("footerStyled") ? style(text) : text)];
  // Split a remote repaint into two asynchronous batches to exercise SSH chunks.
  const halfway = Math.floor(lines.length / 2);
  const first = (synchronized ? "\x1b[?2026h" : "") + "\x1b[H" + lines.slice(0, halfway).map((text) => "\x1b[2K" + text).join("\r\n") + "\r\n";
  const second = lines.slice(halfway).map((text) => "\x1b[2K" + text).join("\r\n") + (synchronized ? "\x1b[?2026l" : "");
  repaints.push({ first, second, offset: renderOffset });
  drainRepaints();
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
    if (performance.now() - lastAcceptedWheel < Number(parameters.get("coalesceWheelMs") ?? 0)) continue;
    lastAcceptedWheel = performance.now();
    if (parameters.has("dropAt") && !dropped && offset === Number(parameters.get("dropAt"))) {
      dropped = true;
      continue;
    }
    const wheelStep = Number(parameters.get("wheelStep") || "2");
    const nextOffset = Math.max(0, Math.min(Number(parameters.get("maxOffset") || "90"), offset + (wheel[1] === "64" ? -wheelStep : wheelStep)));
    if (nextOffset !== offset) {
      offset = nextOffset;
      const delays = parameters.get("delays")?.split(",").map(Number);
      const frameOffset = offset;
      const responseDelay = delays?.[(wheelCount - 1) % delays.length] ?? delay;
      const reportGap = wheelCount > 1 && wheelCount % 2 === 1 ? Number(parameters.get("reportGap") ?? 0) : 0;
      if (parameters.has("separateReports")) scheduleResponse(() => render(false, frameOffset), responseDelay + reportGap);
      else {
        // A coalesced TUI repaint acknowledges one input burst. Late callbacks
        // must not render future wheel inputs ahead of their response delay.
        responseOffset = frameOffset;
        if (!responsePending) {
          responsePending = true;
          scheduleResponse(() => {
            responsePending = false;
            render(false, responseOffset);
          }, responseDelay);
        }
      }
    }
  }
});
terminal.onData(inputWriter.write);
const shortcuts = attachTerminalShortcuts(terminal, selection.getText, (text) => { element("copied").textContent = text; });
const wheelController = attachTerminalWheel(terminal, element("terminal"), () => parameters.has("enhanced"), inputWriter.write);
element("copy").addEventListener("click", () => { element("copied").textContent = selection.getText(); });
element("repaint").addEventListener("click", () => render(true));
element("dispose").addEventListener("click", () => {
  clearInterval(steadyOutput);
  selection.dispose();
  shortcuts.dispose();
  inputWriter.dispose();
  wheelController.dispose();
  output.dispose();
  viewport.dispose();
  disposeTerminal(terminal, rendering);
});
window.resizeTerminalForTest = () => terminal.resize(terminal.cols + 1, terminal.rows + 1);
window.selectTerminalForTest = (first, last) => terminal.select(0, terminal.buffer.active.viewportY + first, (last - first + 1) * terminal.cols);
window.releaseTerminalRepliesForTest = () => {
  holdResponses = false;
  heldReplies.splice(0).forEach((reply) => reply());
};
window.terminalStateForTest = () => ({
  viewportY: terminal.buffer.active.viewportY,
  mouse: terminal.modes.mouseTrackingMode,
  buffer: terminal.buffer.active.type,
  lines: Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true) ?? ""),
});

declare global {
  interface Window {
    resizeTerminalForTest(): void;
    selectTerminalForTest(first: number, last: number): void;
    releaseTerminalRepliesForTest(): void;
    terminalStateForTest(): { viewportY: number; mouse: string; buffer: string; lines: string[] };
  }
}

const steadyOutput = parameters.has("steady") ? setInterval(() => writeOutput("\x1b[0m"), 8) : undefined;
if (shell) {
  const prefix = parameters.has("denseShell") ? "文字内容".repeat(Math.floor((terminal.cols - 20) / 8)) + " " : "";
  terminal.write(Array.from({ length: Number(parameters.get("shellLines") || "100") }, (_, index) => `${prefix}Shell row ${String(index).padStart(3, "0")}`).join("\r\n"), () => {
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

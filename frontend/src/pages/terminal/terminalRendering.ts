import type { Terminal } from "xterm";
import { CanvasAddon } from "xterm-addon-canvas";
import { WebglAddon } from "xterm-addon-webgl";

function hardwareWebglAvailable(doc: Document): boolean {
  const probe = doc.createElement("canvas");
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = probe.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
    // Software WebGL adds GPU emulation overhead and can be slower than Canvas.
    return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch {
    return false;
  } finally {
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** Batch colored glyphs on the GPU; keep Canvas/DOM available when WebGL is
 * restricted or its context is lost while a terminal is open. */
export function configureTerminalRendering(term: Terminal, { preferWebgl }: { preferWebgl?: boolean } = {}): void {
  term.options.smoothScrollDuration = 100;
  const mark = (renderer: string) => {
    if (term.element) term.element.dataset.terminalRenderer = renderer;
  };
  const fallback = () => {
    const canvas = new CanvasAddon();
    try {
      term.loadAddon(canvas);
      mark("canvas");
    } catch {
      canvas.dispose();
      mark("dom");
    }
  };
  if (preferWebgl ?? hardwareWebglAvailable(term.element!.ownerDocument)) {
    let webgl: WebglAddon | undefined;
    let lossListener: { dispose(): void } | undefined;
    const recover = () => {
      lossListener?.dispose();
      lossListener = undefined;
      webgl?.dispose();
      webgl = undefined;
      fallback();
    };
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(recover);
      term.loadAddon(webgl);
      const element = term.element!;
      // The addon waits three seconds for context restoration. Recover on the
      // DOM event immediately, with listener cleanup owned by the terminal.
      const onLoss = (event: Event) => { event.preventDefault(); recover(); };
      lossListener = {
        dispose: () => element.removeEventListener("webglcontextlost", onLoss, true),
      };
      term.loadAddon({
        activate: () => element.addEventListener("webglcontextlost", onLoss, true),
        dispose: () => lossListener?.dispose(),
      });
      mark("webgl");
      return;
    } catch {
      lossListener?.dispose();
      webgl?.dispose();
    }
  }
  fallback();
}

import type { IDisposable, Terminal } from "xterm";
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
 * restricted or its context is lost while a terminal is open.
 * Dispose this controller before the terminal: renderer addons restore the DOM
 * renderer on disposal and need xterm's render service to still be alive. */
export function configureTerminalRendering(term: Terminal, { preferWebgl }: { preferWebgl?: boolean } = {}): IDisposable {
  term.options.smoothScrollDuration = 100;
  let renderer: CanvasAddon | WebglAddon | undefined;
  let lossListener: IDisposable | undefined;
  let disposed = false;
  const rendering: IDisposable = {
    dispose() {
      if (disposed) return;
      disposed = true;
      lossListener?.dispose();
      lossListener = undefined;
      renderer?.dispose();
      renderer = undefined;
    },
  };
  const mark = (renderer: string) => {
    if (term.element) term.element.dataset.terminalRenderer = renderer;
  };
  const fallback = () => {
    const canvas = new CanvasAddon();
    try {
      term.loadAddon(canvas);
      renderer = canvas;
      mark("canvas");
    } catch {
      canvas.dispose();
      mark("dom");
    }
  };
  if (preferWebgl ?? hardwareWebglAvailable(term.element!.ownerDocument)) {
    let webgl: WebglAddon | undefined;
    const recover = () => {
      if (disposed) return;
      lossListener?.dispose();
      lossListener = undefined;
      webgl?.dispose();
      webgl = undefined;
      renderer = undefined;
      fallback();
    };
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(recover);
      term.loadAddon(webgl);
      renderer = webgl;
      const element = term.element!;
      // The addon waits three seconds for context restoration. Recover on the
      // DOM event immediately, with listener cleanup owned by this controller.
      const onLoss = (event: Event) => { event.preventDefault(); recover(); };
      lossListener = {
        dispose: () => element.removeEventListener("webglcontextlost", onLoss, true),
      };
      element.addEventListener("webglcontextlost", onLoss, true);
      mark("webgl");
      return rendering;
    } catch {
      lossListener?.dispose();
      webgl?.dispose();
    }
  }
  fallback();
  return rendering;
}

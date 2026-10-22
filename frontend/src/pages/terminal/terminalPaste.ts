import type { Terminal } from "xterm";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
type PasteOptions = {
  connection: () => object | null;
  upload: (file: File, signal: AbortSignal) => Promise<string>;
  onPaste: () => void;
  onUploading: () => void;
  onUploaded: (count: number) => void;
  onError: (error: Error) => void;
};

/** Browser paste owns local clipboard data; never ask the SSH host to read it. */
export function attachTerminalPaste(term: Terminal, host: HTMLElement, options: PasteOptions) {
  const view = host.ownerDocument.defaultView!;
  const controllers = new Set<AbortController>();
  let disposed = false;
  let pending = 0;
  let queue = Promise.resolve();
  const paste = (text: string, images: File[], draft = false): Promise<boolean> => {
    if (disposed || (!images.length && !text)) return Promise.resolve(false);
    const validateDraft = () => {
      if (draft && /[\r\n]/.test(text) && !term.modes.bracketedPasteMode) throw new Error("Multiline draft requires bracketed paste");
    };
    const connection = options.connection();
    if (!connection) { options.onError(new Error("Terminal is not connected")); return Promise.resolve(false); }
    try { validateDraft(); }
    catch (error) { options.onError(error as Error); return Promise.resolve(false); }
    options.onPaste();
    if (!images.length && !pending) { term.paste(text); return Promise.resolve(true); }
    pending++;
    let applied = false;
    // Preserve paste order when another paste arrives during image upload.
    queue = queue.then(async () => {
      if (disposed) return;
      if (options.connection() !== connection) throw new Error("Terminal connection changed; paste again");
      validateDraft();
      if (!images.length) { term.paste(text); applied = true; return; }
      if (images.some(file => file.size > MAX_IMAGE_BYTES)) throw new Error("Clipboard image exceeds 20 MiB");
      options.onUploading();
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = view.setTimeout(() => controller.abort(), 45000);
      try {
        const paths: string[] = [];
        for (const file of images) paths.push(await options.upload(file, controller.signal));
        if (disposed) return;
        if (options.connection() !== connection) throw new Error("Terminal connection changed; paste again");
        validateDraft();
        // Paste each image separately so Codex recognizes each path as an
        // attachment. xterm preserves the remote bracketed-paste mode.
        for (const path of paths) term.paste(path + " ");
        if (draft && text) term.paste(text);
        applied = true;
        options.onUploaded(paths.length);
      } finally {
        view.clearTimeout(timeout);
        controllers.delete(controller);
      }
    }).catch((error: unknown) => {
      if (!disposed) options.onError(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => { pending--; });
    return queue.then(() => applied);
  };
  const onPaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    // File objects must be copied before the browser invalidates event data.
    const files = Array.from(clipboard.items)
      .filter(item => item.kind === "file" && item.type.startsWith("image/"))
      .map(item => item.getAsFile()).filter((file): file is File => file !== null);
    const images = files.length ? files : Array.from(clipboard.files).filter(file => file.type.startsWith("image/"));
    event.preventDefault();
    event.stopImmediatePropagation();
    void paste(clipboard.getData("text/plain"), images);
  };
  const onKey = (event: KeyboardEvent) => {
    if (!pending || event.key !== "Enter") return;
    // Do not submit the prompt before its image attachments have arrived.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) options.onUploading();
  };
  host.addEventListener("paste", onPaste, true);
  host.addEventListener("keydown", onKey, true);
  return {
    pasteDraft(text: string, images: File[] = []) { return paste(text, images, true); },
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("keydown", onKey, true);
    },
  };
}

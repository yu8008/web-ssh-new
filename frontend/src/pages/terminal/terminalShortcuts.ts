import type { Terminal } from "xterm";

export function attachTerminalShortcuts(term: Terminal, getSelection: () => string, copy: (text: string) => void) {
  const doc = term.element!.ownerDocument;
  const view = doc.defaultView!;
  const onFunctionKey = (event: KeyboardEvent) => {
    if (!/^F(?:[1-9]|1[0-2])$/.test(event.key)) return;
    // Capture at page level: toolbar clicks and selection gestures can leave
    // xterm's textarea unfocused, letting Chrome handle help/reload/etc.
    event.preventDefault();
    const textarea = term.textarea;
    const inTerminal = event.target === textarea;
    const target = event.target instanceof view.HTMLElement ? event.target : null;
    const editingOutside = !inTerminal && target && (
      target.matches("input, textarea, select") || target.isContentEditable || target.closest('[role="textbox"]')
    );
    const modalOpen = doc.querySelector('[aria-modal="true"], dialog[open]');
    if (editingOutside || modalOpen || event.isComposing) {
      // Keep local editors/dialogs in control without leaking a key to SSH.
      if (inTerminal) event.stopPropagation();
      return;
    }
    if (inTerminal || !textarea) return;
    event.stopPropagation();
    if (event.type !== "keydown") return;
    term.focus();
    // Reuse xterm's encoder and onData pipeline, including modifiers/repeats.
    // The forwarded event targets the textarea, so it is not forwarded again.
    textarea.dispatchEvent(new view.KeyboardEvent(event.type, {
      key: event.key, code: event.code, keyCode: event.keyCode, location: event.location,
      ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
      repeat: event.repeat, bubbles: true, cancelable: true, composed: true,
    }));
  };
  doc.addEventListener("keydown", onFunctionKey, true);
  doc.addEventListener("keyup", onFunctionKey, true);

  term.attachCustomKeyEventHandler((event) => {
    // Returning false bypasses xterm's Ctrl+V -> SYN (0x16) mapping. Leave the
    // browser default intact so it dispatches a paste event with local data.
    if (!event.altKey && event.key.toLowerCase() === "v" && (event.ctrlKey || event.metaKey)) return false;
    if (event.type !== "keydown" || event.altKey || event.key.toLowerCase() !== "c") return true;
    const explicitCopy = (event.metaKey && !event.ctrlKey) || (event.ctrlKey && event.shiftKey);
    const interruptOrCopy = event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (!explicitCopy && !interruptOrCopy) return true;
    const selection = getSelection();
    if (!selection && !explicitCopy) return true;
    event.preventDefault();
    if (selection) copy(selection);
    return false;
  });

  return {
    dispose() {
      doc.removeEventListener("keydown", onFunctionKey, true);
      doc.removeEventListener("keyup", onFunctionKey, true);
    },
  };
}

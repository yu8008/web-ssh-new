import type { Terminal } from "xterm";

export function attachTerminalShortcuts(term: Terminal, getSelection: () => string, copy: (text: string) => void) {
  term.attachCustomKeyEventHandler((event) => {
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
}

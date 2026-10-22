import type { Terminal } from "xterm";

export function attachTerminalShortcuts(term: Terminal, getSelection: () => string, copy: (text: string) => void) {
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
}

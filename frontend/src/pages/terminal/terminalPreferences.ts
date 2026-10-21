const SCROLLBACK_KEY = "terminal-scrollback-lines";
export const TERMINAL_SCROLLBACK_CHOICES = [5000, 10000, 50000, 100000];
export function getTerminalScrollback(): number {
  try {
    const value = Number(localStorage.getItem(SCROLLBACK_KEY));
    if (TERMINAL_SCROLLBACK_CHOICES.includes(value)) return value;
  } catch { /* Storage may be restricted; the terminal still works. */ }
  return 10000;
}
export function saveTerminalScrollback(lines: number) {
  if (TERMINAL_SCROLLBACK_CHOICES.includes(lines)) localStorage.setItem(SCROLLBACK_KEY, String(lines));
}

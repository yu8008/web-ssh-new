/** Open a trusted same-origin terminal without replacing the session list.
 * Creating the blank tab first retains sessionStorage for non-remembered
 * logins. Detach its opener before loading the application. */
export function openTerminalTab(sessionId: string): boolean {
  const tab = window.open("about:blank", "_blank");
  if (!tab) return false;
  tab.opener = null;
  tab.location.replace(`/terminal/${encodeURIComponent(sessionId)}`);
  return true;
}

/** Coalesce wheel reports within one display frame. Preserve every report and
 * flush before keys/clicks so scroll bursts cannot delay or reorder other input. */
export function createTerminalInputWriter(view: Window, send: (data: string) => void) {
  let frame: number | undefined;
  let pending = "";
  const flush = () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    if (!pending) return;
    const data = pending;
    pending = "";
    send(data);
  };
  return {
    write(data: string) {
      const wheel = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
      if (wheel && (Number(wheel[1]) & 192) === 64) {
        pending += data;
        if (frame === undefined) frame = view.requestAnimationFrame(flush);
      } else {
        flush();
        send(data);
      }
    },
    dispose() {
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      pending = "";
      frame = undefined;
    },
  };
}

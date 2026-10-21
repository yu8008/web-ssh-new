/** Send the first wheel report immediately, then coalesce a burst per frame.
 * Preserve every report and flush before keys/clicks to retain input order. */
export function createTerminalInputWriter(view: Window, send: (data: string) => void) {
  let frame: number | undefined;
  let pending = "";
  const scheduleFrame = () => {
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      flush();
    });
  };
  const flush = () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    if (!pending) return;
    const data = pending;
    pending = "";
    send(data);
  };
  return {
    flush,
    write(data: string) {
      const wheel = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
      if (wheel && (Number(wheel[1]) & 192) === 64) {
        if (frame === undefined) {
          send(data);
          scheduleFrame();
        } else {
          pending += data;
        }
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

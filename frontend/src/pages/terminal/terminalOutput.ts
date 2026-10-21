export const TERMINAL_OUTPUT_PROTOCOL = "webssh.output.v1";

type OutputJob = { data: string; callbacks?: Array<() => void> };
type OutputOptions = {
  write: (data: string, onParsed: () => void) => void;
  beforeWrite?: () => unknown;
  afterWrite?: (snapshot: unknown) => void;
  onOverflow: () => void;
  chunkSize?: number;
  maxQueuedChars?: number;
  timeBudgetMs?: number;
};

/** Keep only one xterm parse in flight and yield between bounded bursts.
 * Completion callbacks share a write; empty jobs form replay/reset barriers. */
export function createTerminalOutput({
  write, beforeWrite, afterWrite, onOverflow,
  chunkSize = 16 * 1024, maxQueuedChars = 16 * 1024 * 1024, timeBudgetMs = 8,
}: OutputOptions) {
  let queue: OutputJob[] = [];
  let head = 0;
  let queuedChars = 0;
  let writing = false;
  let disposed = false;
  let overflowed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let turnStart = 0;
  let writes = 0;

  const schedule = () => {
    if (disposed || writing || timer !== undefined || head === queue.length) return;
    timer = setTimeout(() => {
      timer = undefined;
      turnStart = performance.now();
      writes = 0;
      drain();
    }, 0);
  };
  const drain = () => {
    if (disposed || writing || head === queue.length) return;
    const job = queue[head++];
    if (!job) return;
    queuedChars -= job.data.length;
    if (head === queue.length) { queue = []; head = 0; }
    else if (head >= 256) { queue = queue.slice(head); head = 0; }
    if (!job.data) {
      job.callbacks?.forEach((callback) => callback());
      schedule();
      return;
    }
    writing = true;
    writes += 1;
    const snapshot = beforeWrite?.();
    write(job.data, () => {
      writing = false;
      if (disposed) return;
      afterWrite?.(snapshot);
      job.callbacks?.forEach((callback) => callback());
      if (writes >= 8 || performance.now() - turnStart >= timeBudgetMs) schedule();
      else drain();
    });
  };
  return {
    enqueue(data: string, onParsed?: () => void) {
      if (disposed || overflowed) return;
      if (queuedChars + data.length > maxQueuedChars) {
        overflowed = true;
        queue = []; head = 0; queuedChars = 0;
        onOverflow();
        return;
      }
      if (!data) {
        if (onParsed) queue.push({ data: "", callbacks: [onParsed] });
      } else {
        let offset = 0;
        while (offset < data.length) {
          const tail = queue.length > head ? queue[queue.length - 1] : undefined;
          const available = tail?.data ? chunkSize - tail.data.length : 0;
          const size = Math.min(available || chunkSize, data.length - offset);
          const part = data.slice(offset, offset + size);
          if (available) tail!.data += part;
          else queue.push({ data: part });
          offset += size;
        }
        queuedChars += data.length;
        if (onParsed) (queue[queue.length - 1].callbacks ??= []).push(onParsed);
      }
      // The socket callback is already an event-loop task. Starting an idle
      // writer here preserves xterm's immediate echo path after user input.
      if (!writing && timer === undefined) {
        turnStart = performance.now();
        writes = 0;
        drain();
      }
    },
    /** A new replay supersedes pending output, after the active parse finishes. */
    replacePending(reset: () => void) {
      if (disposed) return;
      queue = [{ data: "", callbacks: [reset] }]; head = 0; queuedChars = 0;
      overflowed = false;
      schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      queue = []; head = 0; queuedChars = 0;
    },
  };
}

export type TerminalOutputFrame =
  | { type: "pong"; ping_id: number }
  | { type: "replay_start" }
  | { type: "replay_end"; seq: number }
  | { type: "output"; seq: number; data: string };

export function decodeTerminalOutput(data: string): TerminalOutputFrame | null {
  try {
    const frame = JSON.parse(data);
    if (frame?.type === "replay_start") return { type: "replay_start" };
    if (frame?.type === "pong" && Number.isSafeInteger(frame.ping_id) && frame.ping_id >= 0) {
      return { type: "pong", ping_id: frame.ping_id };
    }
    if (!Number.isSafeInteger(frame?.seq) || frame.seq < 0) return null;
    if (frame.type === "replay_end") return { type: "replay_end", seq: frame.seq };
    if (frame.type === "output" && typeof frame.data === "string") return frame;
  } catch { /* Older servers and pre-subscription errors use plain text. */ }
  return null;
}

export const TERMINAL_OUTPUT_PROTOCOL = "webssh.output.v1";
export const TERMINAL_FLOW_PROTOCOL = "webssh.output.v2";
export const isTerminalOutputProtocol = (protocol: string) => protocol === TERMINAL_OUTPUT_PROTOCOL || protocol === TERMINAL_FLOW_PROTOCOL;

type OutputJob = { data: string; queuedAt: number; callbacks?: Array<() => void> };
type OutputOptions = {
  write: (data: string, onParsed: () => void) => void;
  beforeWrite?: () => unknown;
  afterWrite?: (snapshot: unknown) => void;
  onOverflow: () => void;
  chunkSize?: number;
  maxQueuedChars?: number;
  timeBudgetMs?: number;
  inputPending?: () => boolean;
};

/** Keep only one xterm parse in flight and yield between bounded bursts.
 * Completion callbacks share a write; empty jobs form replay/reset barriers. */
export function createTerminalOutput({
  write, beforeWrite, afterWrite, onOverflow,
  chunkSize = 16 * 1024, maxQueuedChars = 16 * 1024 * 1024, timeBudgetMs = 4,
  inputPending = () => false,
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
  let activeSince = 0;
  let activeChars = 0;
  let parseMs = 0;
  let parsedAt = 0;

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
    activeSince = performance.now();
    activeChars = job.data.length;
    writes += 1;
    const snapshot = beforeWrite?.();
    write(job.data, () => {
      writing = false;
      parseMs = performance.now() - activeSince;
      parsedAt = performance.now();
      activeChars = 0;
      if (disposed) return;
      afterWrite?.(snapshot);
      job.callbacks?.forEach((callback) => callback());
      if (writes >= 8 || performance.now() - turnStart >= timeBudgetMs || inputPending()) schedule();
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
        if (onParsed) queue.push({ data: "", queuedAt: performance.now(), callbacks: [onParsed] });
      } else {
        let offset = 0;
        while (offset < data.length) {
          const tail = queue.length > head ? queue[queue.length - 1] : undefined;
          const available = tail?.data ? chunkSize - tail.data.length : 0;
          const size = Math.min(available || chunkSize, data.length - offset);
          const part = data.slice(offset, offset + size);
          if (available) tail!.data += part;
          else queue.push({ data: part, queuedAt: performance.now() });
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
      queue = [{ data: "", queuedAt: performance.now(), callbacks: [reset] }]; head = 0; queuedChars = 0;
      overflowed = false;
      schedule();
    },
    diagnostics() {
      const now = performance.now();
      return {
        queuedChars: queuedChars + activeChars,
        waitMs: writing ? now - activeSince : queue[head] ? now - queue[head].queuedAt : 0,
        parseMs: now - parsedAt < 5000 ? parseMs : 0,
      };
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      queue = []; head = 0; queuedChars = 0;
    },
  };
}

export type TerminalOutputFrame =
  | { type: "pong"; ping_id: number; gateway_queue_ms?: number; gateway_loop_lag_ms?: number; gateway_queued_chars?: number; gateway_inflight_chars?: number }
  | { type: "replay_start" }
  | { type: "replay_end"; seq: number; bracketed_paste?: boolean }
  | { type: "output"; seq: number; data: string; epoch?: string };

export function decodeTerminalOutput(data: string): TerminalOutputFrame | null {
  try {
    const frame = JSON.parse(data);
    if (frame?.type === "replay_start") return { type: "replay_start" };
    if (frame?.type === "pong" && Number.isSafeInteger(frame.ping_id) && frame.ping_id >= 0) {
      const reply: Extract<TerminalOutputFrame, { type: "pong" }> = { type: "pong", ping_id: frame.ping_id };
      for (const key of ["gateway_queue_ms", "gateway_loop_lag_ms", "gateway_queued_chars", "gateway_inflight_chars"] as const) {
        if (typeof frame[key] === "number" && Number.isFinite(frame[key]) && frame[key] >= 0) reply[key] = frame[key];
      }
      return reply;
    }
    if (!Number.isSafeInteger(frame?.seq) || frame.seq < 0) return null;
    if (frame.type === "replay_end") return { type: "replay_end", seq: frame.seq,
      ...(typeof frame.bracketed_paste === "boolean" ? { bracketed_paste: frame.bracketed_paste } : {}) };
    if (frame.type === "output" && typeof frame.data === "string") return { type: "output", seq: frame.seq, data: frame.data, ...(typeof frame.epoch === "string" && frame.epoch.length <= 64 ? { epoch: frame.epoch } : {}) };
  } catch { /* Older servers and pre-subscription errors use plain text. */ }
  return null;
}

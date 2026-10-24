import type { NoticeKind } from "./notificationCore";

type ChimeNote = { delay: number; frequency: number; strength: number };
// A rising fifth resolves completion; three lighter strikes ask for attention.
const COMPLETION: ChimeNote[] = [
  { delay: 0, frequency: 1174.66, strength: .9 },
  { delay: .14, frequency: 1760, strength: 1 },
];
const ATTENTION: ChimeNote[] = [
  { delay: 0, frequency: 1046.50, strength: .85 },
  { delay: .16, frequency: 1318.51, strength: .8 },
  { delay: .36, frequency: 1760, strength: 1 },
];
const BELL: ChimeNote[] = [{ delay: 0, frequency: 880, strength: 1 }];
// The upper harmonics fade first, leaving a clean, rounded glass-like tail.
const PARTIALS = [
  { ratio: 1, weight: .78, decay: 1 },
  { ratio: 2, weight: .17, decay: .45 },
  { ratio: 3, weight: .05, decay: .28 },
];

/** One context per page; initialized/resumed only after an explicit gesture. */
export class NotificationAudio {
  private context: AudioContext | null = null;
  private nodes = new Map<OscillatorNode, number>();
  private output: GainNode | null = null;
  constructor(private changed?: (ready: boolean) => void) {}
  get ready() { return this.context?.state === "running"; }
  async enable(): Promise<boolean> {
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.context.onstatechange = () => this.changed?.(this.ready);
      }
      if (this.context.state !== "running") await this.context.resume();
      return this.ready;
    } catch { this.changed?.(false); return false; }
  }
  stop() {
    const now = this.context?.currentTime ?? 0;
    if (this.output) {
      // Fade the whole chime, including scheduled notes, without a cutoff click.
      this.output.gain.setValueAtTime(this.output.gain.value, now);
      this.output.gain.linearRampToValueAtTime(0, now + .008);
      this.output = null;
    }
    for (const [node, start] of this.nodes) {
      try { node.stop(start > now ? now : now + .008); } catch { /* Already ended. */ }
    }
    this.nodes.clear();
  }
  play(kind: NoticeKind, volume: number): boolean {
    const context = this.context;
    if (!context || !this.ready || !Number.isFinite(volume) || volume <= 0) return false;
    // One notification at a time also bounds peaks during rapid bursts/previews.
    this.stop();
    const attention = kind === "question" || kind === "approval" || kind === "attention";
    const notes = attention ? ATTENTION : kind === "bell" ? BELL : COMPLETION;
    const output = context.createGain();
    output.gain.value = Math.min(1, volume) * .48;
    output.connect(context.destination);
    this.output = output;
    const onset = context.currentTime + .005;
    let remaining = notes.length * PARTIALS.length;
    for (const note of notes) for (const partial of PARTIALS) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = onset + note.delay;
      const duration = (kind === "bell" ? .32 : .46) * partial.decay;
      const peak = note.strength * partial.weight;
      oscillator.type = "sine"; oscillator.frequency.value = note.frequency * partial.ratio;
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + .004);
      gain.gain.exponentialRampToValueAtTime(peak * .4, start + .12 * partial.decay);
      gain.gain.exponentialRampToValueAtTime(.0001, start + duration - .012);
      gain.gain.linearRampToValueAtTime(0, start + duration);
      oscillator.connect(gain); gain.connect(output);
      this.nodes.set(oscillator, start);
      oscillator.onended = () => {
        this.nodes.delete(oscillator); oscillator.disconnect(); gain.disconnect();
        if (--remaining === 0) { output.disconnect(); if (this.output === output) this.output = null; }
      };
      oscillator.start(start); oscillator.stop(start + duration);
    }
    return true;
  }
  dispose() { this.stop(); if (this.context) { this.context.onstatechange = null; void this.context.close(); } this.context = null; }
}

import type { NoticeKind } from "./notificationCore";

/** One context per page; initialized/resumed only after an explicit gesture. */
export class NotificationAudio {
  private context: AudioContext | null = null;
  private nodes = new Set<OscillatorNode>();
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
    for (const node of this.nodes) { try { node.stop(); } catch { /* Already ended. */ } }
    this.nodes.clear();
  }
  play(kind: NoticeKind, volume: number): boolean {
    const context = this.context;
    if (!context || !this.ready || volume <= 0) return false;
    const attention = kind === "question" || kind === "approval" || kind === "attention";
    const notes = attention ? [[0, 660], [0.27, 880]] : [[0, kind === "bell" ? 540 : 740]];
    for (const [delay, frequency] of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + delay;
      oscillator.type = "sine"; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(Math.min(1, Math.max(0, volume)) * 0.18, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25);
      oscillator.connect(gain); gain.connect(context.destination);
      this.nodes.add(oscillator);
      oscillator.onended = () => { this.nodes.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(start); oscillator.stop(start + 0.3);
    }
    return true;
  }
  dispose() { this.stop(); if (this.context) { this.context.onstatechange = null; void this.context.close(); } this.context = null; }
}

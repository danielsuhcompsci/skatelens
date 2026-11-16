// Scores are binary class preferences, never a learned idle/other detector.
export class EventGate {
  constructor({ threshold = .85, confirmations = 2, cooldown = 3500 } = {}) {
    this.threshold = threshold; this.confirmations = confirmations; this.cooldown = cooldown;
    this.reset();
  }
  reset() { this.label = null; this.count = 0; this.lastEvent = -Infinity; this.lastEnd = -Infinity; this.lastCandidateAt = -Infinity; }
  update(result, { now, end, active = true, manual = false }) {
    if (!active) { this.label = null; this.count = 0; return { state: 'idle' }; }
    if (!result || !Number.isFinite(result.confidence) || result.confidence < this.threshold || result.margin < this.threshold * 2 - 1) {
      this.label = null; this.count = 0; return { state: 'unknown' };
    }
    if (end <= this.lastEnd) return { state: 'unknown', reason: 'Repeated window' };
    this.lastEnd = end;
    this.count = result.label === this.label && now - this.lastCandidateAt < 4000 ? this.count + 1 : 1;
    this.lastCandidateAt = now;
    this.label = result.label;
    if (!manual && this.count < this.confirmations) return { state: 'candidate', label: result.label };
    if (now - this.lastEvent < this.cooldown) return { state: 'cooldown' };
    this.lastEvent = now; this.count = 0;
    return { state: 'accepted', label: result.label, confidence: result.confidence };
  }
}
// NumPy rint uses ties-to-even; Math.round does not.
export function roundEven(n) { const f = Math.floor(n); return n - f === .5 ? f + f % 2 : Math.round(n); }
export function sampleIndices(n) { if (n < 1) throw new Error('No decoded frames'); return Array.from({length:16}, (_, i) => roundEven(i * (n - 1) / 15)); }

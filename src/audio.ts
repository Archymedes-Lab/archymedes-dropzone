import type { WeaponId } from './sim/types';

/** Synthesised sound: a shared noise buffer and a few oscillators, no audio files. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  unlock(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
      const length = this.ctx.sampleRate * 0.5;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.32;
    return this.muted;
  }

  private burst(duration: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'bandpass'): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.3, duration + 0.02);
  }

  private tone(freq: number, to: number, duration: number, gain: number, type: OscillatorType = 'sine', delay = 0): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  shot(weapon: WeaponId, distance: number): void {
    const v = Math.max(0, 1 - distance / 40);
    if (v <= 0.02) return;
    if (weapon === 'shotgun') { this.burst(0.28, 900, 0.7, 0.9 * v, 'lowpass'); this.tone(120, 50, 0.18, 0.5 * v, 'triangle'); }
    else if (weapon === 'rifle') { this.burst(0.22, 1800, 0.9, 0.75 * v); this.tone(220, 60, 0.16, 0.45 * v, 'triangle'); }
    else if (weapon === 'smg') this.burst(0.07, 2600, 1.2, 0.45 * v);
    else this.burst(0.11, 2100, 1.0, 0.55 * v);
  }

  hit(shield: boolean): void { this.tone(shield ? 1500 : 1100, shield ? 1900 : 700, 0.07, 0.18, 'square'); }
  hurt(): void { this.burst(0.15, 400, 0.8, 0.5, 'lowpass'); }
  kill(): void { this.tone(660, 990, 0.12, 0.22, 'triangle'); this.tone(990, 1320, 0.16, 0.18, 'triangle', 0.09); }
  pickup(): void { this.tone(880, 1320, 0.1, 0.14, 'sine'); }
  reload(): void { this.burst(0.05, 3200, 2, 0.25); this.burst(0.05, 2400, 2, 0.25); }
  zone(): void { this.tone(180, 140, 0.9, 0.25, 'sawtooth'); }
  jump(): void { this.burst(0.6, 500, 0.5, 0.35, 'lowpass'); }
  chute(): void { this.burst(0.25, 700, 0.6, 0.45, 'lowpass'); }
}

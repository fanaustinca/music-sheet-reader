import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AudioService {
  readonly note$ = new Subject<string | null>();

  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private frameCount = 0;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.tick();
  }

  stop(): void {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.buffer = null;
    this.frameCount = 0;
  }

  private tick = () => {
    if (!this.analyser || !this.buffer || !this.ctx) return;
    this.analyser.getFloatTimeDomainData(this.buffer);
    // Run detection at ~30fps for faster response
    if (++this.frameCount % 2 === 0) {
      const freq = this.autocorrelate(this.buffer, this.ctx.sampleRate);
      this.note$.next(freq > 0 ? this.freqToNote(freq) : null);
    }
    this.rafId = requestAnimationFrame(this.tick);
  };

  private autocorrelate(buf: Float32Array, rate: number): number {
    // Check signal is loud enough
    let rms = 0;
    for (const s of buf) rms += s * s;
    if (Math.sqrt(rms / buf.length) < 0.01) return -1;

    // Search lags covering ~60 Hz to ~1050 Hz (most instruments/vocals)
    const minLag = Math.floor(rate / 1050);
    const maxLag = Math.ceil(rate / 60);

    let bestR = 0.5; // Minimum confidence threshold
    let bestLag = -1;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0, norm = 0;
      for (let i = 0; i + lag < buf.length; i++) {
        corr += buf[i] * buf[i + lag];
        norm += buf[i] * buf[i] + buf[i + lag] * buf[i + lag];
      }
      const r = norm > 0 ? (2 * corr) / norm : 0;
      if (r > bestR) { bestR = r; bestLag = lag; }
    }

    return bestLag > 0 ? rate / bestLag : -1;
  }

  private freqToNote(freq: number): string {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const midi = Math.round(12 * Math.log2(freq / 440) + 69);
    return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  }
}

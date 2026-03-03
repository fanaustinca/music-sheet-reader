import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { GeminiService, SheetAnalysis } from '../../services/gemini.service';
import { AudioService } from '../../services/audio.service';

type NoteResult = 'pending' | 'correct' | 'wrong';

// Treble clef staff line note names (bottom to top)
const STAFF_LINE_LABELS = ['E4', 'G4', 'B4', 'D5', 'F5'];

@Component({
  selector: 'app-scanner',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './scanner.component.html',
  styleUrl: './scanner.component.scss'
})
export class ScannerComponent implements OnDestroy {
  @ViewChild('staffCanvas')  canvasRef?:       ElementRef<HTMLCanvasElement>;
  @ViewChild('resultCanvas') resultCanvasRef?: ElementRef<HTMLCanvasElement>;

  // Upload & analysis
  filePreview: string | null = null;
  isPdf = false;
  base64Data: string | null = null;
  mimeType = 'image/jpeg';
  loading = false;
  error = '';
  result: SheetAnalysis | null = null;

  // Practice
  practiceActive = false;
  practiceComplete = false;
  currentNoteIndex = 0;
  detectedNote: string | null = null;
  noteResults: NoteResult[] = [];
  bpm = 80;

  private noteStartBeats: number[] = [];
  private practiceStartTime = 0;
  private drawRafId: number | null = null;
  private noteTimer: any = null;
  private sub: Subscription | null = null;

  constructor(private gemini: GeminiService, private audio: AudioService) {}

  ngOnDestroy(): void { this.stopPractice(); }

  // ── File handling ──────────────────────────────────────────────────────────

  onFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.mimeType = file.type || 'image/jpeg';
    this.isPdf = file.type === 'application/pdf';
    this.result = null;
    this.error = '';
    this.practiceComplete = false;
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = e.target?.result as string;
      this.filePreview = this.isPdf ? null : data;
      this.base64Data = data.split(',')[1];
    };
    reader.readAsDataURL(file);
  }

  analyze() {
    if (!this.base64Data) return;
    this.loading = true;
    this.error = '';
    this.result = null;
    this.practiceComplete = false;
    this.gemini.analyzeSheet(this.base64Data, this.mimeType).subscribe({
      next: (r) => { this.result = r; this.loading = false; },
      error: (err) => { this.error = 'API error: ' + (err.error?.error?.message || err.message); this.loading = false; }
    });
  }

  // ── Practice controls ──────────────────────────────────────────────────────

  async startPractice() {
    if (!this.result?.notes.length) return;
    this.practiceActive = true;
    this.practiceComplete = false;
    this.currentNoteIndex = 0;
    this.noteResults = this.result.notes.map(() => 'pending' as NoteResult);
    this.error = '';
    this.calculateNoteStartBeats();

    try {
      await this.audio.start();
      this.sub = this.audio.note$.subscribe(note => {
        this.detectedNote = note;
        this.checkNote(note);
      });
    } catch {
      this.error = 'Microphone access denied. Please allow microphone access and try again.';
      this.practiceActive = false;
      return;
    }

    // Wait for Angular to render the canvas before drawing
    setTimeout(() => this.initCanvas(), 50);
  }

  stopPractice() {
    if (this.drawRafId !== null) { cancelAnimationFrame(this.drawRafId); this.drawRafId = null; }
    clearTimeout(this.noteTimer);
    this.audio.stop();
    this.sub?.unsubscribe();
    this.sub = null;
    this.practiceActive = false;
    this.detectedNote = null;
  }

  onBpmInput(event: Event): void {
    const newBpm = parseInt((event.target as HTMLInputElement).value);
    if (!this.practiceActive) { this.bpm = newBpm; return; }

    // Keep visual playhead in sync after BPM change
    const now = performance.now();
    const currentBeats = (now - this.practiceStartTime) / 1000 * (this.bpm / 60);
    this.bpm = newBpm;
    this.practiceStartTime = now - currentBeats * 60000 / this.bpm;

    // Restart the note timer at new tempo
    clearTimeout(this.noteTimer);
    const noteEndBeat = this.noteStartBeats[this.currentNoteIndex] +
      this.durationToBeats(this.result!.notes[this.currentNoteIndex].duration);
    const msLeft = Math.max(150, (noteEndBeat - currentBeats) * 60000 / this.bpm);
    this.scheduleAdvance(msLeft);
  }

  // ── Canvas init & draw loop ────────────────────────────────────────────────

  private initCanvas(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    canvas.width = canvas.parentElement?.clientWidth ?? 360;
    canvas.height = 190;

    const leadInMs = 2 * 60000 / this.bpm;
    this.practiceStartTime = performance.now() + leadInMs;
    setTimeout(() => this.advanceToNote(0), leadInMs);
    this.startDrawLoop(canvas);
  }

  private startDrawLoop(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')!;
    const tick = () => {
      this.drawFrame(canvas, ctx);
      this.drawRafId = requestAnimationFrame(tick);
    };
    this.drawRafId = requestAnimationFrame(tick);
  }

  private drawFrame(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    if (!this.result) return;
    const W = canvas.width, H = canvas.height;
    const LINE_SP = 16;
    const STAFF_BOTTOM = H - 42;
    const LABEL_W = 28;                        // reserved px on left for pitch labels
    const CURSOR_X = Math.round(W * 0.30);     // cursor at 30% — staff visible on both sides
    const PX_PER_BEAT = (W - CURSOR_X) / 4;   // 4 beats visible ahead of cursor
    const NOTE_H = LINE_SP - 3;               // block height — fits snugly between lines

    const playheadBeats = (performance.now() - this.practiceStartTime) / 1000 * (this.bpm / 60);

    // Background
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0f1e';
    ctx.fillRect(0, 0, W, H);

    // Full-width staff lines
    ctx.strokeStyle = 'rgba(226,185,111,0.4)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const ly = STAFF_BOTTOM - i * LINE_SP;
      ctx.beginPath();
      ctx.moveTo(LABEL_W, ly);
      ctx.lineTo(W, ly);
      ctx.stroke();
    }

    // Pitch labels pinned to left edge
    ctx.fillStyle = 'rgba(226,185,111,0.5)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    for (let i = 0; i < 5; i++) {
      ctx.fillText(STAFF_LINE_LABELS[i], 2, STAFF_BOTTOM - i * LINE_SP + 3);
    }

    // Note blocks — width = duration in beats × px per beat
    for (let i = 0; i < this.result.notes.length; i++) {
      const bx  = CURSOR_X + (this.noteStartBeats[i] - playheadBeats) * PX_PER_BEAT;
      const bw  = Math.max(4, this.durationToBeats(this.result.notes[i].duration) * PX_PER_BEAT - 2);
      if (bx + bw < LABEL_W || bx > W) continue;

      const sp = this.noteToStaffPos(this.result.notes[i].note);
      const cy = STAFF_BOTTOM - sp * (LINE_SP / 2);

      const color =
        this.noteResults[i] === 'correct' ? '#4caf50' :
        this.noteResults[i] === 'wrong'   ? '#f44336' :
        i === this.currentNoteIndex        ? '#e2b96f' :
                                             'rgba(200,220,255,0.6)';

      // Ledger lines for notes outside the staff
      this.drawLedgerLinesForBlock(ctx, sp, bx, bw, W, STAFF_BOTTOM, LINE_SP, color);

      // Clip block to visible area
      const dx = Math.max(LABEL_W, bx);
      const dw = Math.min(W, bx + bw) - dx;
      if (dw <= 0) continue;

      ctx.globalAlpha = i === this.currentNoteIndex ? 1 : 0.75;
      ctx.fillStyle = color;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(dx, cy - NOTE_H / 2, dw, NOTE_H, 3);
      else               ctx.rect(dx, cy - NOTE_H / 2, dw, NOTE_H);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Note name inside block when wide enough
      if (dw > 24) {
        ctx.fillStyle = '#0a0f1e';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        const lx = Math.min(dx + dw / 2, Math.min(W, bx + bw) - 4);
        ctx.fillText(this.result.notes[i].note, lx, cy + 3);
      }
    }

    // Cursor — drawn on top of notes
    ctx.save();
    ctx.shadowColor = '#e2b96f';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = '#e2b96f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CURSOR_X, 0);
    ctx.lineTo(CURSOR_X, H);
    ctx.stroke();
    ctx.restore();

    // Current note name above cursor
    if (this.currentNoteIndex < this.result.notes.length) {
      ctx.fillStyle = '#e2b96f';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(this.result.notes[this.currentNoteIndex].note, CURSOR_X, 14);
    }
  }

  private drawLedgerLinesForBlock(
    ctx: CanvasRenderingContext2D,
    p: number, bx: number, bw: number, W: number,
    staffBottom: number, lineSpacing: number, color: string
  ): void {
    const positions: number[] = [];
    if (p <= -2) {
      const floor = p % 2 === 0 ? p : p + 1;
      for (let lp = -2; lp >= floor; lp -= 2) positions.push(lp);
    }
    if (p >= 10) {
      const ceil = p % 2 === 0 ? p : p - 1;
      for (let lp = 10; lp <= ceil; lp += 2) positions.push(lp);
    }
    if (!positions.length) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.65;
    for (const lp of positions) {
      const ly = staffBottom - lp * (lineSpacing / 2);
      ctx.beginPath();
      ctx.moveTo(Math.max(28, bx - 3), ly);
      ctx.lineTo(Math.min(W, bx + bw + 3), ly);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ── Timer & note logic ─────────────────────────────────────────────────────

  private advanceToNote(index: number): void {
    if (index >= this.result!.notes.length) {
      setTimeout(() => this.completePractice(), 1500);
      return;
    }
    this.currentNoteIndex = index;
    const ms = this.durationToBeats(this.result!.notes[index].duration) * (60000 / this.bpm);
    this.scheduleAdvance(ms);
  }

  private scheduleAdvance(ms: number): void {
    this.noteTimer = setTimeout(() => {
      if (this.noteResults[this.currentNoteIndex] === 'pending') {
        this.noteResults[this.currentNoteIndex] = 'wrong';
      }
      this.advanceToNote(this.currentNoteIndex + 1);
    }, ms);
  }

  private completePractice(): void {
    if (this.drawRafId !== null) { cancelAnimationFrame(this.drawRafId); this.drawRafId = null; }
    this.audio.stop();
    this.sub?.unsubscribe();
    this.sub = null;
    this.practiceActive = false;
    this.practiceComplete = true;
    this.detectedNote = null;
    // Wait for Angular to render the result canvas
    setTimeout(() => this.renderResultStaff(), 80);
  }

  // ── Static result staff ────────────────────────────────────────────────────

  private renderResultStaff(): void {
    const canvas = this.resultCanvasRef?.nativeElement;
    if (!canvas || !this.result) return;

    const W = canvas.parentElement?.clientWidth ?? 360;
    canvas.width = W;

    const LINE_SP    = 14;
    const NOTE_R     = 5.5;
    const MARGIN_L   = 36;   // left space for pitch labels
    const MARGIN_R   = 12;
    const BEATS_ROW  = 4;    // beats per row
    const PX_BEAT    = (W - MARGIN_L - MARGIN_R) / BEATS_ROW;
    const TOP_PAD    = 34;   // space above staff (stems go up)
    const BOT_PAD    = 28;   // space below staff (stems go down + ledger lines)
    const STAFF_H    = LINE_SP * 4;
    const ROW_H      = TOP_PAD + STAFF_H + BOT_PAD;

    // ── Layout: assign each note a row and x ──────────────────────────────
    const layouts: { noteIdx: number; row: number; x: number; staffBottom: number }[] = [];
    let row = 0, beatInRow = 0;

    for (let i = 0; i < this.result.notes.length; i++) {
      const dur = this.durationToBeats(this.result.notes[i].duration);
      if (beatInRow > 0.01 && beatInRow + dur > BEATS_ROW + 0.01) {
        row++; beatInRow = 0;
      }
      layouts.push({
        noteIdx: i,
        row,
        x: MARGIN_L + beatInRow * PX_BEAT + 10,
        staffBottom: row * ROW_H + TOP_PAD + STAFF_H,
      });
      beatInRow += dur;
      if (beatInRow >= BEATS_ROW - 0.01) { row++; beatInRow = 0; }
    }

    const lastRow = layouts.at(-1)?.row ?? 0;
    canvas.height = (lastRow + 1) * ROW_H + 10;

    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, W, canvas.height);

    // ── Staff lines + pitch labels for each row ───────────────────────────
    for (let r = 0; r <= lastRow; r++) {
      const sb = r * ROW_H + TOP_PAD + STAFF_H;

      ctx.strokeStyle = 'rgba(226,185,111,0.75)';
      ctx.lineWidth = 1;
      for (let li = 0; li < 5; li++) {
        const ly = sb - li * LINE_SP;
        ctx.beginPath();
        ctx.moveTo(MARGIN_L, ly);
        ctx.lineTo(W - MARGIN_R, ly);
        ctx.stroke();
      }

      // Barline at end
      ctx.beginPath();
      ctx.moveTo(W - MARGIN_R, sb - 4 * LINE_SP);
      ctx.lineTo(W - MARGIN_R, sb);
      ctx.stroke();

      // Pitch labels
      ctx.fillStyle = 'rgba(226,185,111,0.85)';
      ctx.font = '8px monospace';
      ctx.textAlign = 'right';
      for (let li = 0; li < 5; li++) {
        ctx.fillText(STAFF_LINE_LABELS[li], MARGIN_L - 2, sb - li * LINE_SP + 3);
      }
    }

    // ── Notes ─────────────────────────────────────────────────────────────
    for (const l of layouts) {
      const note  = this.result.notes[l.noteIdx];
      const color = this.noteResults[l.noteIdx] === 'correct' ? '#4caf50' : '#f44336';
      const sp    = this.noteToStaffPos(note.note);
      const cy    = l.staffBottom - sp * (LINE_SP / 2);

      this.drawResultLedger(ctx, sp, l.x, l.staffBottom, LINE_SP, NOTE_R, color);
      this.drawResultNote(ctx, note.duration, l.x, cy, NOTE_R, sp, color);

      // Note label below the notehead
      ctx.fillStyle = color;
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(note.note, l.x, l.staffBottom + BOT_PAD - 4);
    }
  }

  private drawResultNote(
    ctx: CanvasRenderingContext2D,
    duration: string, x: number, y: number,
    r: number, sp: number, color: string
  ): void {
    const dur    = duration.toLowerCase();
    const isOpen = dur === 'whole' || dur === 'half';
    const stemUp = sp <= 4;

    // Notehead
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.68, -0.2, 0, Math.PI * 2);
    if (isOpen) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke();
    } else {
      ctx.fillStyle = color; ctx.fill();
    }

    // Stem
    if (dur !== 'whole') {
      const sx  = stemUp ? x + r * 0.78 : x - r * 0.78;
      const sy0 = stemUp ? y - r * 0.65  : y + r * 0.65;
      const sy1 = sy0 + (stemUp ? -28 : 28);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx, sy0); ctx.lineTo(sx, sy1); ctx.stroke();

      // Flag(s)
      const flags = dur === 'eighth' ? 1 : dur === 'sixteenth' ? 2 : 0;
      for (let f = 0; f < flags; f++) {
        const fy = stemUp ? sy1 + f * 8 : sy1 - f * 8;
        ctx.beginPath();
        ctx.moveTo(sx, fy);
        ctx.quadraticCurveTo(sx + 12, fy + (stemUp ? 10 : -10), sx + 6, fy + (stemUp ? 20 : -20));
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
  }

  private drawResultLedger(
    ctx: CanvasRenderingContext2D,
    p: number, x: number, staffBottom: number,
    lineSpacing: number, noteR: number, color: string
  ): void {
    const positions: number[] = [];
    if (p <= -2) {
      const floor = p % 2 === 0 ? p : p + 1;
      for (let lp = -2; lp >= floor; lp -= 2) positions.push(lp);
    }
    if (p >= 10) {
      const ceil = p % 2 === 0 ? p : p - 1;
      for (let lp = 10; lp <= ceil; lp += 2) positions.push(lp);
    }
    if (!positions.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.7;
    for (const lp of positions) {
      const ly = staffBottom - lp * (lineSpacing / 2);
      ctx.beginPath();
      ctx.moveTo(x - noteR * 1.8, ly);
      ctx.lineTo(x + noteR * 1.8, ly);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private checkNote(detected: string | null): void {
    if (!detected || !this.practiceActive) return;
    if (this.currentNoteIndex >= (this.result?.notes.length ?? 0)) return;
    if (this.noteResults[this.currentNoteIndex] === 'correct') return;

    const pitch = detected.replace(/\d/g, '');
    const expected = this.result!.notes[this.currentNoteIndex].note.replace(/\d/g, '');
    if (pitch === expected) this.noteResults[this.currentNoteIndex] = 'correct';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private calculateNoteStartBeats(): void {
    this.noteStartBeats = [];
    let total = 0;
    for (const note of this.result!.notes) {
      this.noteStartBeats.push(total);
      total += this.durationToBeats(note.duration);
    }
  }

  private durationToBeats(duration: string): number {
    const map: Record<string, number> = {
      whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25
    };
    return map[duration?.toLowerCase()] ?? 1;
  }

  private noteToStaffPos(note: string): number {
    const letters = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    const letter = note.match(/[A-G]/)?.[0] ?? 'C';
    const octave = parseInt(note.match(/\d+/)?.[0] ?? '4');
    const diatonic = octave * 7 + letters.indexOf(letter);
    return diatonic - (4 * 7 + 2); // 0 = E4, the bottom treble clef line
  }

  get isMatch(): boolean {
    if (!this.detectedNote || this.currentNoteIndex >= (this.result?.notes.length ?? 0)) return false;
    return this.detectedNote.replace(/\d/g, '') === this.result!.notes[this.currentNoteIndex].note.replace(/\d/g, '');
  }

  get accuracy(): number {
    const done = this.noteResults.filter(r => r !== 'pending').length;
    return done ? Math.round(this.noteResults.filter(r => r === 'correct').length / done * 100) : 0;
  }
}

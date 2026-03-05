import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AnalysisService, SheetAnalysis } from '../../services/analysis.service';
import { AudioService } from '../../services/audio.service';

type NoteResult = 'pending' | 'correct' | 'wrong';

// Treble clef staff line note names (bottom to top)
const STAFF_LINE_LABELS = ['E4', 'G4', 'B4', 'D5', 'F5'];

@Component({
  selector: 'app-scanner',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './scanner.component.html',
  styleUrl: './scanner.component.scss'
})
export class ScannerComponent implements OnDestroy {
  @ViewChild('staffCanvas')  canvasRef?:        ElementRef<HTMLCanvasElement>;
  @ViewChild('vexContainer') vexContainerRef?: ElementRef<HTMLDivElement>;

  // Upload & analysis
  filePreview: string | null = null;
  isPdf = false;
  base64Data: string | null = null;
  mimeType = 'image/jpeg';
  loading = false;
  error = '';
  result: SheetAnalysis | null = null;
  multiSection = false;
  sectionNotes: SheetAnalysis['notes'][] = [];   // one entry per detected section
  selectedSection = -1;                          // -1 = all sections

  // Practice
  practiceActive = false;
  practiceComplete = false;
  currentNoteIndex = 0;
  detectedNote: string | null = null;
  noteResults: NoteResult[] = [];
  bpm = 80;
  repeatCount = 1;
  activeNotes: SheetAnalysis['notes'] = [];   // result.notes × repeatCount

  private noteStartBeats: number[] = [];
  private practiceStartTime = 0;
  private drawRafId: number | null = null;
  private noteTimer: any = null;
  private sub: Subscription | null = null;

  constructor(private analysis: AnalysisService, private audio: AudioService) {}

  ngOnDestroy(): void { this.stopPractice(); }

  // ── File handling ──────────────────────────────────────────────────────────

  async onFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.mimeType  = file.type || 'image/jpeg';
    this.isPdf     = file.type === 'application/pdf';
    this.result    = null;
    this.error     = '';
    this.filePreview = null;
    this.practiceComplete = false;

    // Read file as data URL
    const dataUrl = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target!.result as string);
      reader.readAsDataURL(file);
    });
    this.base64Data = dataUrl.split(',')[1];

    if (this.isPdf) {
      try {
        this.filePreview = await this.pdfToStitchedImage(file);
      } catch { /* keep raw PDF data */ }
    } else {
      this.filePreview = dataUrl;
    }
  }

  private async pdfToStitchedImage(file: File): Promise<string> {
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url
    ).href;
    const buf      = await file.arrayBuffer();
    const pdf      = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const numPages = pdf.numPages;
    const scale    = numPages > 2 ? 1.5 : 2;

    const pages: HTMLCanvasElement[] = [];
    for (let i = 1; i <= numPages; i++) {
      const page  = await pdf.getPage(i);
      const vp    = page.getViewport({ scale });
      const c     = document.createElement('canvas');
      c.width  = vp.width;
      c.height = vp.height;
      await page.render({ canvas: c, viewport: vp }).promise;
      pages.push(c);
    }

    if (pages.length === 1) return pages[0].toDataURL('image/jpeg', 0.92);

    // Stitch all pages vertically into one image
    const totalW = Math.max(...pages.map(c => c.width));
    const totalH = pages.reduce((h, c) => h + c.height, 0);
    const out    = document.createElement('canvas');
    out.width    = totalW;
    out.height   = totalH;
    const ctx    = out.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalW, totalH);
    let y = 0;
    for (const c of pages) { ctx.drawImage(c, 0, y); y += c.height; }
    return out.toDataURL('image/jpeg', 0.92);
  }

  async onXmlSelected(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.error = '';
    this.result = null;
    this.practiceComplete = false;
    try {
      const xmlStr = await file.text();
      const parsed = this.parseMusicXmlClient(xmlStr);
      if (!parsed.notes.length) { this.error = 'No notes found in XML file.'; return; }
      this.result = parsed;
    } catch (e: any) {
      this.error = 'Failed to parse XML: ' + (e.message ?? e);
    }
  }

  private parseMusicXmlClient(xmlStr: string): SheetAnalysis {
    const FIFTHS: Record<number, string> = {
      '-7':'Cb','-6':'Gb','-5':'Db','-4':'Ab','-3':'Eb','-2':'Bb','-1':'F',
      0:'C', 1:'G', 2:'D', 3:'A', 4:'E', 5:'B', 6:'F#', 7:'C#'
    };
    const DURATION: Record<string, string> = {
      whole:'whole', half:'half', quarter:'quarter', eighth:'eighth',
      '16th':'sixteenth', '32nd':'thirty-second'
    };
    const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
    const txt = (root: Element | Document, tag: string) =>
      root.querySelector(tag)?.textContent?.trim() ?? '';

    const title    = txt(doc, 'work-title') || txt(doc, 'movement-title');
    let   composer = '';
    for (const c of doc.querySelectorAll('creator')) {
      if (c.getAttribute('type') === 'composer') { composer = c.textContent?.trim() ?? ''; break; }
    }

    let key = '';
    const keyEl = doc.querySelector('key');
    if (keyEl) {
      const fifths = parseInt(txt(keyEl, 'fifths'));
      const mode   = txt(keyEl, 'mode') || 'major';
      key = `${FIFTHS[fifths] ?? ''} ${mode}`.trim();
    }

    let timeSignature = '';
    const timeEl = doc.querySelector('time');
    if (timeEl) {
      const b = txt(timeEl, 'beats'), bt = txt(timeEl, 'beat-type');
      if (b && bt) timeSignature = `${b}/${bt}`;
    }

    let tempo = '';
    const metro = doc.querySelector('metronome');
    if (metro) {
      const unit = txt(metro, 'beat-unit'), pm = txt(metro, 'per-minute');
      if (pm) tempo = `${unit} = ${pm}`;
    }
    if (!tempo) tempo = doc.querySelector('words')?.textContent?.trim() ?? '';

    // Collect notes per measure with repeat tracking
    type MGroup = { notes: SheetAnalysis['notes']; hasForward: boolean; repeatTimes: number };
    const measureGroups: MGroup[] = [];
    for (const measure of doc.querySelectorAll('measure')) {
      const hasForward = [...measure.querySelectorAll('barline')]
        .some(b => b.querySelector('repeat')?.getAttribute('direction') === 'forward');
      const backwardBl = [...measure.querySelectorAll('barline')]
        .find(b => b.querySelector('repeat')?.getAttribute('direction') === 'backward');
      const repeatTimes = backwardBl
        ? parseInt(backwardBl.querySelector('repeat')?.getAttribute('times') ?? '2')
        : 0;

      const mNotes: SheetAnalysis['notes'] = [];
      for (const n of measure.querySelectorAll('note')) {
        if (n.querySelector('rest')) continue;
        if ([...n.querySelectorAll('tie')].some(t => t.getAttribute('type') === 'stop')) continue;
        const pitch = n.querySelector('pitch');
        if (!pitch) continue;
        const step   = txt(pitch, 'step');
        const octave = txt(pitch, 'octave');
        const alter  = parseFloat(txt(pitch, 'alter') || '0');
        const acc    = alter === 2 ? '##' : alter === 1 ? '#' : alter === -1 ? 'b' : alter === -2 ? 'bb' : '';
        const type   = n.querySelector('type')?.textContent?.trim() ?? 'quarter';
        mNotes.push({ note: `${step}${acc}${octave}`, duration: DURATION[type] ?? 'quarter' });
      }
      measureGroups.push({ notes: mNotes, hasForward, repeatTimes });
    }

    // Expand repeat sections
    const notes: SheetAnalysis['notes'] = [];
    let repeatStart = 0;
    for (let i = 0; i < measureGroups.length; i++) {
      const { notes: mn, hasForward, repeatTimes } = measureGroups[i];
      if (hasForward) repeatStart = i;
      notes.push(...mn);
      if (repeatTimes > 1) {
        for (let t = 1; t < repeatTimes; t++)
          for (let j = repeatStart; j <= i; j++) notes.push(...measureGroups[j].notes);
        repeatStart = i + 1;
      }
    }

    return { title, composer, key, timeSignature, tempo, notes };
  }

  analyze() {
    if (!this.base64Data) return;
    this.loading = true;
    this.error = '';
    this.result = null;
    this.practiceComplete = false;

    this.sectionNotes = [];
    this.selectedSection = -1;

    if (this.multiSection && this.isPdf && this.filePreview) {
      // Detect white gaps between systems → split into parallel strips
      this.splitImageAtGaps(this.filePreview).then(strips => {
        if (strips.length > 1) {
          this.analyzeStrips(strips);
        } else {
          this.runSingleAnalysis();
        }
      });
    } else {
      this.runSingleAnalysis();
    }
  }

  private runSingleAnalysis(): void {
    this.analysis.analyzeSheet(this.base64Data!, this.mimeType).subscribe({
      next: (r) => { this.result = r; this.sectionNotes = []; this.loading = false; },
      error: (err) => { this.error = 'Analysis failed: ' + (err.error?.error || err.message || 'Unknown error'); this.loading = false; }
    });
  }

  /** Finds white horizontal gaps between staff systems and returns image strips (base64 JPEG). */
  private splitImageAtGaps(dataUrl: string): Promise<string[]> {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const W = img.width, H = img.height;
        const tmp = document.createElement('canvas');
        tmp.width = W; tmp.height = H;
        const ctx = tmp.getContext('2d')!;
        ctx.drawImage(img, 0, 0);

        // Scan 8%–92% of height — skip page margins
        const startY   = Math.floor(H * 0.08);
        const endY     = Math.floor(H * 0.92);
        // A real inter-system gap is at least 2% of page height (avoids staff-line false positives)
        const minGap   = Math.max(15, Math.floor(H * 0.02));
        // A strip must be tall enough to contain a full staff system (~8% of page height)
        const minStrip = Math.max(60, Math.floor(H * 0.08));
        // Padding added above/below each strip so Audiveris sees full staff context
        const PAD      = Math.floor(H * 0.01);

        const gaps: { center: number; size: number }[] = [];
        let inGap = false, gapStart = 0;

        for (let y = startY; y <= endY; y++) {
          const row = ctx.getImageData(0, y, W, 1).data;
          let sum = 0;
          for (let x = 0; x < row.length; x += 4) sum += (row[x] + row[x + 1] + row[x + 2]) / 3;
          const isWhite = (sum / W) > 245; // near-pure white only
          if (isWhite && !inGap) { inGap = true; gapStart = y; }
          else if (!isWhite && inGap) {
            inGap = false;
            const size = y - gapStart;
            if (size >= minGap) gaps.push({ center: gapStart + Math.floor(size / 2), size });
          }
        }
        if (inGap) {
          const size = endY - gapStart;
          if (size >= minGap) gaps.push({ center: gapStart + Math.floor(size / 2), size });
        }

        if (gaps.length === 0) { resolve([dataUrl.split(',')[1]]); return; }

        // Take the 3 largest gaps as split points (at most 4 strips)
        const splitPoints = gaps
          .sort((a, b) => b.size - a.size)
          .slice(0, 3)
          .map(g => g.center)
          .sort((a, b) => a - b);

        const bounds = [0, ...splitPoints, H];
        const strips: string[] = [];
        for (let i = 0; i < bounds.length - 1; i++) {
          const y1 = bounds[i], y2 = bounds[i + 1];
          if (y2 - y1 < minStrip) continue; // skip slivers

          // Add vertical padding so Audiveris sees full staff context
          const py1 = Math.max(0, y1 - PAD);
          const py2 = Math.min(H, y2 + PAD);
          const sc  = document.createElement('canvas');
          sc.width  = W;
          sc.height = py2 - py1;
          const sCtx = sc.getContext('2d')!;
          sCtx.fillStyle = '#ffffff';
          sCtx.fillRect(0, 0, W, sc.height);
          sCtx.drawImage(img, 0, py1, W, py2 - py1, 0, 0, W, py2 - py1);
          strips.push(sc.toDataURL('image/jpeg', 0.97).split(',')[1]);
        }

        resolve(strips.length > 0 ? strips : [dataUrl.split(',')[1]]);
      };
      img.src = dataUrl;
    });
  }

  /** Runs analysis on all strips in parallel and merges results. Falls back to full PDF if all strips fail. */
  private analyzeStrips(strips: string[]): void {
    const calls = strips.map(s =>
      this.analysis.analyzeSheet(s, 'image/jpeg')
        .pipe(catchError(() => of(null as SheetAnalysis | null)))
    );
    forkJoin(calls).subscribe({
      next: (results) => {
        const valid = results.filter((r): r is SheetAnalysis => !!r && r.notes.length > 0);
        if (!valid.length) {
          // All strips failed — fall back to the full PDF
          this.runSingleAnalysis();
          return;
        }
        this.result = this.mergeResults(valid);
        this.loading = false;
      },
      error: () => this.runSingleAnalysis()
    });
  }

  private mergeResults(results: SheetAnalysis[]): SheetAnalysis {
    this.sectionNotes    = results.map(r => r.notes);
    this.selectedSection = -1;
    const first = results[0];
    return {
      title: first.title, composer: first.composer,
      key: first.key, timeSignature: first.timeSignature, tempo: first.tempo,
      notes: results.flatMap(r => r.notes),
    };
  }

  // ── Practice controls ──────────────────────────────────────────────────────

  async startPractice() {
    if (!this.result?.notes.length) return;
    this.practiceActive = true;
    this.practiceComplete = false;
    this.currentNoteIndex = 0;
    // Build the note sequence for this practice session (with repeats)
    const base = (this.selectedSection >= 0 && this.sectionNotes[this.selectedSection])
      ? this.sectionNotes[this.selectedSection]
      : this.result!.notes;
    this.activeNotes = Array.from({ length: this.repeatCount }, () => base).flat();
    this.noteResults = this.activeNotes.map(() => 'pending' as NoteResult);
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
    const noteEndMs = this.practiceStartTime + noteEndBeat * (60000 / this.bpm);
    this.scheduleAdvance(Math.max(50, noteEndMs - performance.now()));
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
    for (let i = 0; i < this.activeNotes.length; i++) {
      const bx  = CURSOR_X + (this.noteStartBeats[i] - playheadBeats) * PX_PER_BEAT;
      const bw  = Math.max(4, this.durationToBeats(this.activeNotes[i].duration) * PX_PER_BEAT - 2);
      if (bx + bw < LABEL_W || bx > W) continue;

      const sp = this.noteToStaffPos(this.activeNotes[i].note);
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
        ctx.fillText(this.activeNotes[i].note, lx, cy + 3);
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
    if (this.currentNoteIndex < this.activeNotes.length) {
      ctx.fillStyle = '#e2b96f';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(this.activeNotes[this.currentNoteIndex].note, CURSOR_X, 14);
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
    if (index >= this.activeNotes.length) {
      setTimeout(() => this.completePractice(), 1500);
      return;
    }
    this.currentNoteIndex = index;

    // Use absolute time from practiceStartTime to avoid accumulated drift
    const noteEndBeat = this.noteStartBeats[index] + this.durationToBeats(this.activeNotes[index].duration);
    const noteEndMs = this.practiceStartTime + noteEndBeat * (60000 / this.bpm);
    this.scheduleAdvance(Math.max(50, noteEndMs - performance.now()));
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

  private async renderResultStaff(): Promise<void> {
    const container = this.vexContainerRef?.nativeElement;
    if (!container || !this.result) return;
    const W = container.clientWidth || 360;
    await this.renderVexFlowSheet(container, W, true, this.activeNotes);
  }

  /** Renders VexFlow sheet music into a div (canvas backend) and optionally overlays coloured bars. */
  private async renderVexFlowSheet(container: HTMLDivElement, W: number, showColors: boolean, notesOverride?: SheetAnalysis['notes']): Promise<void> {
    const { Renderer, Stave, StaveNote, Voice, Formatter, Accidental, Font } = await import('vexflow');

    // Load music fonts from CDN and wait until fully active in the browser
    await Promise.all([Font.load('Bravura'), Font.load('Academico')]);
    await document.fonts.ready;

    // Create a fresh canvas inside the container (no CSS class → no width:100% distortion)
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);

    const notes = notesOverride ?? this.result!.notes;
    const [beatsStr, beatTypeStr] = (this.result!.timeSignature || '4/4').split('/');
    const beatsPerMeasure = parseInt(beatsStr) || 4;
    const beatType        = parseInt(beatTypeStr) || 4;

    // Group notes into measures
    const measures: typeof notes[] = [];
    let cur: typeof notes = [];
    let acc = 0;
    for (const n of notes) {
      cur.push(n);
      acc += this.durationToBeats(n.duration);
      if (acc >= beatsPerMeasure - 0.01) { measures.push(cur); cur = []; acc = 0; }
    }
    if (cur.length) measures.push(cur);

    // Pad to a multiple of MEASURES_PER_ROW so every row is full
    const MEASURES_PER_ROW = 4;
    while (measures.length % MEASURES_PER_ROW !== 0) measures.push([]);
    const STAVE_W = (W - 20) / MEASURES_PER_ROW;
    const ROW_H   = 150;
    const rows    = Math.ceil(measures.length / MEASURES_PER_ROW);
    const H       = rows * ROW_H + 20;

    // Canvas backend — renderer.resize handles DPR scaling internally
    const renderer = new Renderer(canvas, Renderer.Backends.CANVAS);
    renderer.resize(W, H);

    // White background (must be drawn after resize since resize clears the canvas)
    const nCtx = canvas.getContext('2d')!;
    nCtx.fillStyle = '#ffffff';
    nCtx.fillRect(0, 0, W, H);
    // Reset to black so VexFlow inherits the correct default ink colour
    nCtx.fillStyle   = '#000000';
    nCtx.strokeStyle = '#000000';

    const vfCtx  = renderer.getContext();
    const vexKey = this.getVexKey(this.result!.key || '');
    const positions: { x: number; y: number; staffTop: number; staffBottom: number; sp: number }[] = [];

    for (let mi = 0; mi < measures.length; mi++) {
      const row    = Math.floor(mi / MEASURES_PER_ROW);
      const col    = mi % MEASURES_PER_ROW;
      const staveX = 10 + col * STAVE_W;
      const staveY = row * ROW_H + 40;

      const stave = new Stave(staveX, staveY, STAVE_W);
      if (col === 0) {
        stave.addClef('treble');
        if (vexKey && vexKey !== 'C' && vexKey !== 'Am') stave.addKeySignature(vexKey);
      }
      if (mi === 0) stave.addTimeSignature(this.result!.timeSignature || '4/4');
      stave.setContext(vfCtx).draw();

      const staffTop    = stave.getYForLine(0);
      const staffBottom = stave.getYForLine(4);
      const sp          = stave.getSpacingBetweenLines();
      const noteAreaW   = stave.getWidth() - (stave.getNoteStartX() - stave.getX());

      const vfNotes = measures[mi].map(n =>
        new StaveNote({ keys: [this.noteToVexKey(n.note)], duration: this.durationToVex(n.duration) })
      );

      // Skip empty padding measures (no notes to format)
      if (vfNotes.length > 0) {
        const voice = new Voice({ numBeats: beatsPerMeasure, beatValue: beatType })
          .setStrict(false)
          .addTickables(vfNotes);
        Accidental.applyAccidentals([voice], vexKey || 'C');
        new Formatter().joinVoices([voice]).format([voice], noteAreaW - 10);
        voice.draw(vfCtx, stave);

        for (const vfNote of vfNotes) {
          const ys    = (vfNote as any).getYs?.() as number[] | undefined;
          const nhX1  = (vfNote as any).getNoteHeadBeginX?.() as number | undefined;
          const nhX2  = (vfNote as any).getNoteHeadEndX?.()   as number | undefined;
          const cx    = (nhX1 != null && nhX2 != null) ? (nhX1 + nhX2) / 2 : (vfNote as any).getAbsoluteX();
          positions.push({
            x: cx,
            y: ys?.[0] ?? (staffTop + staffBottom) / 2,
            staffTop, staffBottom, sp
          });
        }
      }
    }

    // Overlay green/red dots directly on each notehead
    if (showColors) {
      for (let i = 0; i < Math.min(positions.length, notes.length); i++) {
        const { x, y, sp } = positions[i];
        const color    = this.noteResults[i] === 'correct' ? '#4caf50' : '#f44336';
        const r        = Math.max(5, sp * 0.62);
        const fontSize = Math.max(9, Math.round(sp * 0.88));

        nCtx.save();
        // Filled circle on the notehead
        nCtx.beginPath();
        nCtx.arc(x, y, r, 0, Math.PI * 2);
        nCtx.globalAlpha = 0.45;
        nCtx.fillStyle   = color;
        nCtx.fill();
        nCtx.globalAlpha = 1;
        // Note label above the dot
        nCtx.font        = `bold ${fontSize}px monospace`;
        nCtx.fillStyle   = color;
        nCtx.textAlign   = 'center';
        nCtx.shadowColor = 'rgba(0,0,0,0.7)';
        nCtx.shadowBlur  = 2;
        nCtx.fillText(notes[i].note, x, y - r - 2);
        nCtx.restore();
      }
    }
  }

  async downloadPdf(): Promise<void> {
    if (!this.result) return;
    const W     = 900;
    const A4_H  = Math.round(W * 297 / 210); // ≈ 1271 px per A4 page
    const { jsPDF } = await import('jspdf');
    const pdf   = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    let firstPage = true;

    // When multiple sections were detected, render each section separately
    const sections = this.sectionNotes.length > 1 ? this.sectionNotes : [this.result.notes];

    for (const secNotes of sections) {
      const tmpDiv = document.createElement('div');
      tmpDiv.style.cssText = 'position:absolute;left:-9999px;top:0;width:900px';
      document.body.appendChild(tmpDiv);
      try {
        await this.renderVexFlowSheet(tmpDiv, W, false, secNotes);
        const canvas = tmpDiv.querySelector('canvas') as HTMLCanvasElement | null;
        if (!canvas) continue;

        const totalH   = canvas.height;
        const numPages = Math.ceil(totalH / A4_H);

        for (let page = 0; page < numPages; page++) {
          if (!firstPage) pdf.addPage();
          firstPage = false;

          const sliceH = Math.min(A4_H, totalH - page * A4_H);
          const slice  = document.createElement('canvas');
          slice.width  = W;
          slice.height = sliceH;
          const sCtx   = slice.getContext('2d')!;
          sCtx.fillStyle = '#ffffff';
          sCtx.fillRect(0, 0, W, sliceH);
          sCtx.drawImage(canvas, 0, page * A4_H, W, sliceH, 0, 0, W, sliceH);
          pdf.addImage(slice.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 210, sliceH * 210 / W);
        }
      } finally {
        document.body.removeChild(tmpDiv);
      }
    }

    pdf.save(`${this.result.title || 'sheet-music'}.pdf`);
  }


  private checkNote(detected: string | null): void {
    if (!detected || !this.practiceActive) return;
    if (this.currentNoteIndex >= this.activeNotes.length) return;
    if (this.noteResults[this.currentNoteIndex] === 'correct') return;

    const pitch = detected.replace(/\d/g, '');
    const expected = this.activeNotes[this.currentNoteIndex].note.replace(/\d/g, '');
    if (pitch === expected) this.noteResults[this.currentNoteIndex] = 'correct';
  }


  private getVexKey(keyStr: string): string {
    const m = keyStr?.match(/^([A-G][#b]?)\s*(major|minor)/i);
    if (!m) return 'C';
    return m[2].toLowerCase() === 'minor' ? `${m[1]}m` : m[1];
  }

  private noteToVexKey(note: string): string {
    const m = note.match(/([A-G])(#{1,2}|b{1,2})?(\d+)/);
    if (!m) return 'c/4';
    return `${m[1].toLowerCase()}${m[2] ?? ''}/${m[3]}`;
  }

  private durationToVex(duration: string): string {
    const map: Record<string, string> = {
      whole: 'w', half: 'h', quarter: 'q', eighth: '8', sixteenth: '16', 'thirty-second': '32',
      'dotted-half': 'hd', 'dotted-quarter': 'qd', 'dotted-eighth': '8d',
    };
    return map[duration?.toLowerCase()] ?? 'q';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private calculateNoteStartBeats(): void {
    this.noteStartBeats = [];
    let total = 0;
    for (const note of this.activeNotes) {
      this.noteStartBeats.push(total);
      total += this.durationToBeats(note.duration);
    }
  }

  private durationToBeats(duration: string): number {
    const map: Record<string, number> = {
      whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25, 'thirty-second': 0.125,
      'dotted-half': 3, 'dotted-quarter': 1.5, 'dotted-eighth': 0.75,
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
    if (!this.detectedNote || this.currentNoteIndex >= this.activeNotes.length) return false;
    return this.detectedNote.replace(/\d/g, '') === this.activeNotes[this.currentNoteIndex].note.replace(/\d/g, '');
  }

  get accuracy(): number {
    const done = this.noteResults.filter(r => r !== 'pending').length;
    return done ? Math.round(this.noteResults.filter(r => r === 'correct').length / done * 100) : 0;
  }
}

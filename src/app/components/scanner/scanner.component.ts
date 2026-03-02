import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { GeminiService, SheetAnalysis } from '../../services/gemini.service';

@Component({
  selector: 'app-scanner',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './scanner.component.html',
  styleUrl: './scanner.component.scss'
})
export class ScannerComponent {
  filePreview: string | null = null;
  isPdf = false;
  base64Data: string | null = null;
  mimeType: string = 'image/jpeg';
  loading = false;
  error = '';
  result: SheetAnalysis | null = null;

  constructor(private gemini: GeminiService) {}

  onFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.mimeType = file.type || 'image/jpeg';
    this.isPdf = file.type === 'application/pdf';
    this.result = null;
    this.error = '';
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
    this.gemini.analyzeSheet(this.base64Data, this.mimeType).subscribe({
      next: (result) => { this.result = result; this.loading = false; },
      error: (err) => { this.error = 'API error: ' + (err.error?.error?.message || err.message); this.loading = false; }
    });
  }
}

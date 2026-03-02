import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';

export interface NoteEntry {
  note: string;
  duration: string;
}

export interface SheetAnalysis {
  title: string;
  composer: string;
  key: string;
  timeSignature: string;
  tempo: string;
  notes: NoteEntry[];
}

@Injectable({ providedIn: 'root' })
export class GeminiService {
  private apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${environment.geminiApiKey}`;

  constructor(private http: HttpClient) {}

  analyzeSheet(base64Data: string, mimeType: string): Observable<SheetAnalysis> {
    const prompt = `You are a professional music notation expert. Analyze this sheet music and extract the following information. Respond ONLY with a valid JSON object, no markdown, no explanation.

{
  "title": "song title or empty string if not visible",
  "composer": "composer name or empty string if not visible",
  "key": "key signature e.g. C major, G minor",
  "timeSignature": "time signature e.g. 4/4, 3/4",
  "tempo": "tempo marking e.g. Allegro, 120 BPM, or empty string if not visible",
  "notes": [
    { "note": "C4", "duration": "quarter" },
    { "note": "D4", "duration": "half" }
  ]
}

For note durations use: whole, half, quarter, eighth, sixteenth.
List all notes in order as they appear in the sheet music.`;

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64Data } }
        ]
      }]
    };

    return this.http.post<any>(this.apiUrl, body).pipe(
      map(res => {
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end === -1) return { title: '', composer: '', key: '', timeSignature: '', tempo: '', notes: [] };
        return JSON.parse(text.slice(start, end + 1)) as SheetAnalysis;
      })
    );
  }
}

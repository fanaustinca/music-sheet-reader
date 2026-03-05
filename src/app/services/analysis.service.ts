import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
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
export class AnalysisService {
  private audiverisUrl = environment.audiverisApiUrl;

  constructor(private http: HttpClient) {}

  analyzeSheet(base64Data: string, mimeType: string): Observable<SheetAnalysis> {
    return this.http.post<SheetAnalysis>(`${this.audiverisUrl}/analyze`, { data: base64Data, mimeType });
  }
}

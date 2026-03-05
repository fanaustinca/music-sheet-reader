'use strict';

const { XMLParser } = require('fast-xml-parser');

const FIFTHS_MAP = {
  '-7': 'Cb', '-6': 'Gb', '-5': 'Db', '-4': 'Ab',
  '-3': 'Eb', '-2': 'Bb', '-1': 'F',
  '0': 'C',
  '1': 'G', '2': 'D', '3': 'A', '4': 'E', '5': 'B', '6': 'F#', '7': 'C#'
};

const DURATION_MAP = {
  whole: 'whole', half: 'half', quarter: 'quarter', eighth: 'eighth',
  '16th': 'sixteenth', '32nd': 'thirty-second',
};

const DURATION_BEATS = {
  whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25, 'thirty-second': 0.125,
  'dotted-half': 3, 'dotted-quarter': 1.5, 'dotted-eighth': 0.75,
};

function beatsToGuration(b) {
  if (b >= 4)    return 'whole';
  if (b >= 3)    return 'dotted-half';
  if (b >= 2)    return 'half';
  if (b >= 1.5)  return 'dotted-quarter';
  if (b >= 1)    return 'quarter';
  if (b >= 0.75) return 'dotted-eighth';
  if (b >= 0.5)  return 'eighth';
  return 'sixteenth';
}

function parseMusicXml(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (tagName) => [
      'part', 'measure', 'note', 'direction', 'direction-type',
      'metronome', 'words', 'creator', 'tie', 'barline'
    ].includes(tagName),
    parseAttributeValue: true,
    parseTagValue: true,
  });

  const doc = parser.parse(xmlString);
  const score = doc['score-partwise'] || doc;

  // ── Title & composer ───────────────────────────────────────────────────────
  let title = '';
  let composer = '';

  const work = score['work'];
  if (work) title = String(work['work-title'] ?? work['movement-title'] ?? '').trim();
  if (!title) title = String(score['movement-title'] ?? '').trim();

  const identification = score['identification'];
  if (identification) {
    const creators = identification['creator'];
    if (Array.isArray(creators)) {
      for (const c of creators) {
        if (c['@_type'] === 'composer') { composer = String(c['#text'] ?? c ?? '').trim(); break; }
      }
    } else if (typeof creators === 'object' && creators?.['@_type'] === 'composer') {
      composer = String(creators['#text'] ?? '').trim();
    } else if (typeof creators === 'string') {
      composer = creators.trim();
    }
  }

  // ── Parts & measures ───────────────────────────────────────────────────────
  let keyStr = '';
  let timeSignature = '';
  let tempo = '';

  const parts = score['part'];
  if (!Array.isArray(parts) || parts.length === 0) {
    return { title, composer, key: keyStr, timeSignature, tempo, notes: [] };
  }

  const part = parts[0];
  const measures = Array.isArray(part['measure'])
    ? part['measure']
    : [part['measure']].filter(Boolean);

  // Collect notes grouped by measure, tracking repeat barlines
  const measureGroups = [];
  let lastNote = null; // for accumulating tied durations across measures

  for (const measure of measures) {
    if (!measure) continue;

    // Key signature (first occurrence)
    if (!keyStr) {
      const key = measure['attributes']?.['key'];
      if (key) {
        const fifths = key['fifths'];
        const mode = String(key['mode'] ?? 'major').toLowerCase();
        keyStr = `${FIFTHS_MAP[String(fifths)] ?? `${fifths} fifths`} ${mode}`;
      }
    }

    // Time signature (first occurrence)
    if (!timeSignature) {
      const time = measure['attributes']?.['time'];
      if (time?.['beats'] != null && time?.['beat-type'] != null) {
        timeSignature = `${time['beats']}/${time['beat-type']}`;
      }
    }

    // Tempo (first occurrence)
    if (!tempo) {
      for (const dir of (measure['direction'] ?? [])) {
        for (const dt of (dir['direction-type'] ?? [])) {
          const metro = dt['metronome'];
          if (metro?.['per-minute'] != null) {
            tempo = `${metro['beat-unit'] ?? 'quarter'} = ${metro['per-minute']}`;
            break;
          }
          const words = dt['words'];
          if (words && !tempo) {
            const text = Array.isArray(words)
              ? words.map(w => (typeof w === 'object' ? w['#text'] ?? '' : String(w))).join(' ')
              : String(typeof words === 'object' ? words['#text'] ?? '' : words);
            if (text.trim()) tempo = text.trim();
          }
        }
        if (tempo) break;
      }
    }

    // Detect repeat barlines
    const barlines = Array.isArray(measure['barline'])
      ? measure['barline']
      : (measure['barline'] ? [measure['barline']] : []);

    const hasForwardRepeat = barlines.some(b => b['repeat']?.['@_direction'] === 'forward');
    const backwardBl       = barlines.find(b => b['repeat']?.['@_direction'] === 'backward');
    const repeatTimes      = backwardBl ? Number(backwardBl['repeat']?.['@_times'] ?? 2) : 0;

    // Collect this measure's notes
    const mNotes = [];
    for (const n of (measure['note'] ?? [])) {
      if (n['rest'] !== undefined) continue;

      const ties = n['tie'] ?? [];
      const hasTieStop  = ties.some(t => t['@_type'] === 'stop');

      const pitch = n['pitch'];
      if (!pitch) continue;

      const step   = String(pitch['step'] ?? 'C');
      const octave = pitch['octave'] ?? 4;
      const alter  = pitch['alter'];

      let acc = '';
      if      (alter ===  2) acc = '##';
      else if (alter ===  1) acc = '#';
      else if (alter === -1) acc = 'b';
      else if (alter === -2) acc = 'bb';

      const duration = DURATION_MAP[String(n['type'] ?? 'quarter').toLowerCase()] ?? 'quarter';

      if (hasTieStop && lastNote) {
        // Accumulate this note's duration onto the previous tied note
        const prev = DURATION_BEATS[lastNote.duration] ?? 1;
        const add  = DURATION_BEATS[duration] ?? 1;
        lastNote.duration = beatsToGuration(prev + add);
      } else {
        const noteObj = { note: `${step}${acc}${octave}`, duration };
        mNotes.push(noteObj);
        lastNote = noteObj;
      }
    }

    measureGroups.push({ notes: mNotes, hasForwardRepeat, repeatTimes });
  }

  // Expand repeat sections
  const notes = [];
  let repeatStart = 0;

  for (let i = 0; i < measureGroups.length; i++) {
    const { notes: mn, hasForwardRepeat, repeatTimes } = measureGroups[i];

    if (hasForwardRepeat) repeatStart = i;
    notes.push(...mn);

    if (repeatTimes > 1) {
      // Play the section (repeatTimes - 1) additional times
      for (let t = 1; t < repeatTimes; t++) {
        for (let j = repeatStart; j <= i; j++) {
          notes.push(...measureGroups[j].notes);
        }
      }
      repeatStart = i + 1; // next section starts after this repeat
    }
  }

  return { title, composer, key: keyStr, timeSignature, tempo, notes };
}

module.exports = { parseMusicXml };

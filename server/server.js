'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { parseMusicXml } = require('./parse-musicxml');

const app = express();
const PORT = process.env.PORT || 3000;

// Path to Audiveris executable — override with AUDIVERIS_PATH env var
const AUDIVERIS_BIN = process.env.AUDIVERIS_PATH || '/opt/audiveris/bin/Audiveris';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

/**
 * POST /analyze
 * Body: { data: string (base64), mimeType: string }
 * Returns: SheetAnalysis JSON
 */
app.post('/analyze', async (req, res) => {
  const { data, mimeType } = req.body;

  if (!data || !mimeType) {
    return res.status(400).json({ error: 'Missing data or mimeType' });
  }

  const id = uuidv4();
  const ext = mimeType === 'application/pdf' ? 'pdf' : 'jpg';
  const inputPath = `/tmp/${id}.${ext}`;
  const outputDir = `/tmp/${id}-out`;

  try {
    // Write base64 input to temp file
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(inputPath, buffer);
    fs.mkdirSync(outputDir, { recursive: true });

    // Run Audiveris
    const xmlString = await runAudiveris(inputPath, outputDir, id);

    // Debug: save full XML for inspection
    fs.writeFileSync('/tmp/last-audiveris-output.xml', xmlString, 'utf8');
    console.log('Full XML saved to /tmp/last-audiveris-output.xml');

    // Parse MusicXML → SheetAnalysis
    const analysis = parseMusicXml(xmlString);
    console.log(`Parsed: ${analysis.notes.length} notes, key="${analysis.key}", time="${analysis.timeSignature}"`);
    return res.json(analysis);

  } catch (err) {
    console.error('Audiveris error:', err.message || err);
    return res.status(500).json({ error: err.message || 'Audiveris processing failed' });
  } finally {
    // Clean up temp files
    try { fs.rmSync(inputPath, { force: true }); } catch {}
    try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}
  }
});

/**
 * Runs Audiveris in batch mode and returns the MusicXML string.
 */
function runAudiveris(inputPath, outputDir, id) {
  return new Promise((resolve, reject) => {
    const args = ['-batch', '-export', '-output', outputDir, '--', inputPath];

    execFile(AUDIVERIS_BIN, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`Audiveris exited with error: ${stderr || err.message}`));
      }

      // Look for .mxl or .xml output in the output directory
      let xmlString = null;
      try {
        const files = fs.readdirSync(outputDir);

        // Prefer .mxl (compressed MusicXML)
        const mxlFile = files.find(f => f.endsWith('.mxl'));
        if (mxlFile) {
          // .mxl is a ZIP — extract the XML inside
          const mxlPath = path.join(outputDir, mxlFile);
          xmlString = extractMxl(mxlPath);
        }

        // Fall back to plain .xml
        if (!xmlString) {
          const xmlFile = files.find(f => f.endsWith('.xml'));
          if (xmlFile) {
            xmlString = fs.readFileSync(path.join(outputDir, xmlFile), 'utf8');
          }
        }

        // Audiveris sometimes writes into a subdirectory named after the input file
        if (!xmlString) {
          for (const entry of files) {
            const sub = path.join(outputDir, entry);
            if (fs.statSync(sub).isDirectory()) {
              const subFiles = fs.readdirSync(sub);
              const mxl = subFiles.find(f => f.endsWith('.mxl'));
              if (mxl) { xmlString = extractMxl(path.join(sub, mxl)); break; }
              const xml = subFiles.find(f => f.endsWith('.xml'));
              if (xml) { xmlString = fs.readFileSync(path.join(sub, xml), 'utf8'); break; }
            }
          }
        }
      } catch (readErr) {
        return reject(new Error(`Failed to read Audiveris output: ${readErr.message}`));
      }

      if (!xmlString) {
        return reject(new Error('Audiveris produced no MusicXML output'));
      }

      resolve(xmlString);
    });
  });
}

/**
 * Extracts MusicXML from a .mxl (ZIP) file using Node.js built-ins.
 * Requires the `yauzl` package, but we use a simpler approach: read the
 * known entry name. For robustness we shell out to unzip.
 */
function extractMxl(mxlPath) {
  const { execFileSync } = require('child_process');
  const tmpDir = mxlPath + '-extracted';
  try {
    // Extract all files to a temp directory
    fs.mkdirSync(tmpDir, { recursive: true });
    execFileSync('unzip', ['-o', mxlPath, '-d', tmpDir], { timeout: 10000 });

    // Find the MusicXML file (not META-INF/container.xml)
    const allFiles = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) walk(full);
        else allFiles.push(full);
      }
    };
    walk(tmpDir);

    const xmlFile = allFiles.find(f => f.endsWith('.xml') && !f.includes('META-INF'));
    if (xmlFile) return fs.readFileSync(xmlFile, 'utf8');
    return null;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Audiveris server listening on port ${PORT}`);
  console.log(`Audiveris binary: ${AUDIVERIS_BIN}`);
});

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const app = express();

// Static frontend files (index.html, app.js, pcm-worklet.js) live at the repo
// root so their root-relative references ("/app.js", "/src/...") work
// identically under Express here and under Vercel's zero-config static
// serving in production — no vercel.json needed for the frontend. Only the
// specific root-level static files are served (not the whole repo root,
// which would also expose server/, api/, package.json, .env.example…).
app.get('/', (_req, res) => res.sendFile(path.join(repoRoot, 'index.html')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(repoRoot, 'app.js')));
app.get('/pcm-worklet.js', (_req, res) => res.sendFile(path.join(repoRoot, 'pcm-worklet.js')));
app.use('/src', express.static(path.join(repoRoot, 'src')));

// Mint a short-lived streaming token so the API key never reaches the browser.
app.get('/api/token', async (_req, res) => {
  try {
    const r = await fetch(
      'https://streaming.assemblyai.com/v3/token?expires_in_seconds=600',
      { headers: { Authorization: process.env.ASSEMBLYAI_API_KEY } }
    );
    if (!r.ok) throw new Error(`AssemblyAI token endpoint: ${r.status}`);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Read-Along Coach → http://localhost:${port}`));

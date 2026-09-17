import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/src', express.static(path.join(__dirname, '..', 'src')));

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

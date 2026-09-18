// Vercel serverless function (zero-config: any file under /api/*.js becomes
// an endpoint automatically, no framework or build step required).
// Mirrors the /api/token route in server/index.js used for local dev —
// keep the two in sync if the token-mint logic ever changes.
//
// Dependency-free on purpose: Vercel's Node runtime provides fetch natively,
// so this does not need express. ASSEMBLYAI_API_KEY must be set in the
// Vercel project's Environment Variables dashboard — it is never committed.
export default async function handler(req, res) {
  try {
    const r = await fetch(
      'https://streaming.assemblyai.com/v3/token?expires_in_seconds=600',
      { headers: { Authorization: process.env.ASSEMBLYAI_API_KEY } }
    );
    if (!r.ok) throw new Error(`AssemblyAI token endpoint: ${r.status}`);
    res.status(200).json(await r.json());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

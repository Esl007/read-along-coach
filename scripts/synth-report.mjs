/**
 * Shared stdout parsing for scripts/synth_kokoro.py.
 *
 * WHY THIS IS NOT JSON.parse(stdout)
 *
 * synth_kokoro.py writes progress to stderr and its result object to stdout,
 * which would make a bare parse correct — except that anything else living in
 * the venv can also write to stdout, and kokoro does:
 *
 *   WARNING: Defaulting repo_id to hexgrad/Kokoro-82M. ...
 *
 * lands on stdout ahead of the JSON. That made `npm run build:voices` exit 1
 * on a bare JSON.parse. It has failed this way before in a nastier form: the
 * clips rendered fine, the wrapper threw while parsing, and the manifest was
 * left listing the PREVIOUS voice engine's vocabulary. Since the manifest is
 * the contract the app reads, 210 successfully rendered words became
 * unreachable and most of the passages went silent — with every individual
 * step having "worked".
 *
 * So: scan for balanced top-level objects, respecting string literals and
 * escapes, and return the last one that parses. Callers must treat null as a
 * hard failure and surface the raw bytes.
 */
export function extractLastJsonObject(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]);
    } catch { /* not it; try the one before */ }
  }
  return null;
}

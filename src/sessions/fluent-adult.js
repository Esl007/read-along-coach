// Session script (a): a fluent adult reading the lighthouse passage —
// steady cadence, high confidence, no fragments, no stalls.
import { PASSAGES, words } from '../passages.js';

const passageId = 'lighthouse-4';
const passage = PASSAGES.find((p) => p.id === passageId);

let t = 600;
const events = words(passage).map((text) => {
  const start = t, end = t + 280;
  t = end + 120; // ~150 wpm
  return { text, confidence: 0.96, start, end };
});

export const session = {
  id: 'fluent-adult',
  title: 'Fluent adult read',
  passageId,
  events,
};

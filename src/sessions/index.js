// Bundled demo session scripts, one per persona. Order here is the order the
// demo <select> renders: fluent baseline first, then progressively more
// interesting failure modes.
import { session as fluentAdult } from './fluent-adult.js';
import { session as haltingEarlyReader } from './halting-early-reader.js';
import { session as selfCorrectingReader } from './self-correcting-reader.js';
import { session as eslCareful } from './esl-careful.js';
import { session as eslPluralDrop } from './esl-plural-drop.js';

export const SESSIONS = [
  fluentAdult,
  haltingEarlyReader,
  selfCorrectingReader,
  eslCareful,
  eslPluralDrop,
];

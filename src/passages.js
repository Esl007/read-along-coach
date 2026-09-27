// Leveled passages (original text, written for this project). `level` ≈ US grade.
//
// The ladder is deliberately graded, not just "more text":
//   levels 1–2  short decodable words + high-frequency sight words, one clause
//               per sentence, almost no multisyllabics;
//   levels 3–4  compound sentences, past tense, concrete everyday vocabulary;
//   levels 5–6  subordinate clauses, expository/informational register,
//               domain nouns a strong elementary reader can decode;
//   levels 7–8  multi-clause sentences with semicolons, abstract nouns,
//               Latinate/technical vocabulary.
//
// Every passage is kept to roughly 25–60 words on purpose: a read-aloud
// assessment needs to finish inside a demo, and WCPM is stable well before a
// minute of reading.
//
// IDs ARE A STABLE API. Saved session history (localStorage `rac-history`) and
// the recorded demo scripts in src/sessions/ reference passages by id, so
// `cat-1`, `caterpillar-2`, `lighthouse-4` and `esl-news-adult` (and now every
// id added below) must never be renamed or have their text edited — changing
// the text would desync the recorded demo word events and invalidate history.
const ENTRIES = [
  {
    id: 'cat-1',
    title: 'The Cat and the Sun',
    level: 1,
    text: 'The cat sat in the sun. The sun was warm. The cat was happy. ' +
          'A big dog ran by. The cat did not move. The cat was too warm to care.',
  },
  {
    id: 'red-hen-1',
    title: 'The Red Hen',
    level: 1,
    text: 'The red hen has ten eggs. She sits on the nest all day. ' +
          'The sun goes down. The eggs do not move. Then one egg cracks. ' +
          'A wet chick peeps at the hen.',
  },
  {
    id: 'caterpillar-2',
    title: 'The Hungry Caterpillar Next Door',
    level: 2,
    text: 'A small green caterpillar lived on the tomato plant in our garden. ' +
          'Every morning it ate another leaf. My sister said it would become a ' +
          'butterfly, but I thought it would become enormous instead.',
  },
  {
    id: 'frogs-rain-2',
    title: 'Frogs in the Rain',
    level: 2,
    text: 'Rain fell on the pond all afternoon. The frogs did not mind at all. ' +
          'They sang from the reeds until the sky turned pink. My brother counted ' +
          'nine of them before dinner, but I am sure he counted the same frog twice.',
  },
  {
    id: 'sandcastle-3',
    title: 'The Castle That Would Not Stay',
    level: 3,
    text: 'We built a sandcastle close to the water, with four towers and a deep ' +
          'moat around it. My cousin warned me that the tide was coming in. ' +
          'I told her the walls were strong. The next wave proved my cousin right.',
  },
  {
    id: 'lighthouse-4',
    title: 'The Lighthouse Keeper',
    level: 4,
    text: 'The lighthouse keeper climbed the spiral staircase every evening at dusk. ' +
          'From the top she could see fishing boats returning to the harbor, their ' +
          'lanterns swaying like fireflies on the dark water. Her light guided each ' +
          'one safely past the rocks.',
  },
  {
    id: 'bike-chain-4',
    title: 'Fixing the Chain',
    level: 4,
    text: 'The chain slipped off my bicycle halfway up the hill, so I turned it ' +
          'upside down on the grass. Grease covered my hands before the chain ' +
          'finally sat back on the gear. I rode home slower than usual, but I rode home.',
  },
  {
    id: 'honeybees-5',
    title: 'How Bees Share Directions',
    level: 5,
    text: 'When a honeybee finds a field of clover, it returns to the hive and dances. ' +
          'The angle of its dance points toward the sun; the length tells the others ' +
          'how far to travel. Hundreds of bees leave on directions given without a ' +
          'single word.',
  },
  {
    id: 'tide-pool-6',
    title: 'The Tide Pool',
    level: 6,
    text: 'Twice a day the ocean withdraws and leaves behind shallow basins in the ' +
          'rock, each one a crowded neighborhood. Anemones fold themselves shut, ' +
          'crabs negotiate the borders, and a single sea star works patiently at a ' +
          'mussel. Everything here survives by tolerating extremes.',
  },
  {
    id: 'printing-press-7',
    title: 'The Press That Changed Reading',
    level: 7,
    text: 'Before the printing press, a single book could take a scribe a year to ' +
          'copy, and any error he made was quietly inherited by every later reader. ' +
          'Movable type did not merely make books cheaper; it made disagreement ' +
          'possible, because two people could finally compare identical pages.',
  },
  {
    id: 'ice-cores-8',
    title: 'Reading the Ice',
    level: 8,
    text: 'Glaciologists drill cylinders of ice from the Antarctic plateau and read ' +
          'them the way a historian reads a ledger. Each layer traps the atmosphere ' +
          'of the year it fell, so a core several kilometers long becomes a ' +
          'continuous record of climate, volcanic ash, and human industry.',
  },
  {
    id: 'esl-news-adult',
    title: 'Adult / ESL: The Interview',
    level: 8,
    text: 'Preparing thoroughly for an interview means researching the organization, ' +
          'rehearsing concise answers, and anticipating difficult questions. ' +
          'Confidence grows from preparation, not from luck.',
  },
];

// Exported already sorted by level so the UI <select> renders the ladder in
// ascending order without the view layer needing to know about ordering.
// Array.prototype.sort is stable, so passages sharing a level keep their
// declaration order above (and PASSAGES[0] stays `cat-1`, the default pick).
export const PASSAGES = ENTRIES.slice().sort((a, b) => a.level - b.level);

export const words = (p) => p.text.split(/\s+/);

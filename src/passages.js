// Leveled passages (public domain / original). Level ≈ US grade.
export const PASSAGES = [
  {
    id: 'cat-1',
    title: 'The Cat and the Sun',
    level: 1,
    text: 'The cat sat in the sun. The sun was warm. The cat was happy. ' +
          'A big dog ran by. The cat did not move. The cat was too warm to care.',
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
    id: 'lighthouse-4',
    title: 'The Lighthouse Keeper',
    level: 4,
    text: 'The lighthouse keeper climbed the spiral staircase every evening at dusk. ' +
          'From the top she could see fishing boats returning to the harbor, their ' +
          'lanterns swaying like fireflies on the dark water. Her light guided each ' +
          'one safely past the rocks.',
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

export const words = (p) => p.text.split(/\s+/);

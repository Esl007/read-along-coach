// Session script (c): an adult ESL learner reading "The Interview" —
// careful, deliberate pace with a hesitation fragment before "researching"
// and a couple of low-confidence words ("organisation" for "organization,"
// stays unscorable; "thoroughly" is heard shakily but correctly).
const w = (text, start, end, confidence = 0.92, final = true) =>
  ({ text, confidence, start, end, final });

export const session = {
  id: 'esl-careful',
  title: 'ESL careful read',
  passageId: 'esl-news-adult',
  events: [
    w('preparing', 700, 1200),
    w('thoroughly', 1900, 2600, 0.5),   // heard shakily; matches, still correct
    w('for', 3100, 3300),
    w('an', 3700, 3850),
    w('interview', 4300, 4900),
    w('means', 5500, 5850),
    w('re', 7300, 7450, 0.3, false),     // hesitation before the long word
    w('researching', 8800, 9600),
    w('the', 10100, 10250),
    w('organisation', 10800, 11700, 0.4), // low-confidence miss → unscorable
    w('rehearsing', 12500, 13200),
    w('concise', 13800, 14300),
    w('answers', 14700, 15200),
    w('and', 15800, 15950),
    w('anticipating', 16500, 17400),
    w('difficult', 17900, 18450),
    w('questions', 18850, 19400),
    w('confidence', 20400, 21100),
    w('grows', 21500, 21850),
    w('from', 22250, 22450),
    w('preparation', 22900, 23700),
    w('not', 24200, 24400),
    w('from', 24800, 25000),
    w('luck', 25400, 25750),
  ],
};

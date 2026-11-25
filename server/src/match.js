/**
 * Word-level matching between a shopping query and product names, shared by
 * the search filter and the basket's choice of product.
 */

// Store abbreviations and synonyms, written out so they match the query's words.
const EXPANSIONS = [
  [/לל"?ג/gu, 'ללא גלוטן'],
  [/ללת"?ס/gu, 'ללא תוספת סוכר'],
  [/לל"?ס/gu, 'ללא סוכר'],
  [/(^|[\s(])נטול(?:ת|י|ות)?(?=\s)/gu, '$1ללא'],
];
// Sizes and units say how much, not what the product is ("ליטר" matched kettles for "מים 1.5 ליטר").
const UNIT_WORDS = new Set(['ליטר', 'ליט', 'לי', 'מל', 'גרם', 'גר', 'קילו', 'קג', 'יח', 'יחי', 'יחידה', 'יחידות', 'ml', 'kg', 'gr']);
const GRADE = /^(xs|s|m|l|xl|xxl)$/i;
const HEBREW_PREFIX = /^[והבלמשכ](?=[֐-׿]{3})/u;

/**
 * Words that make a product a variant of what was asked for, or something made
 * from it. A product carrying one the query does not is a worse match: Diet or
 * lemon Zero for "קוקה קולה", Omega-3 for "ביצים", milk chocolate for "חלב".
 */
const VARIANT_WORDS = new Set([
  'זירו', 'דיאט', 'דייט', 'לייט', 'לימון', 'בטעם', 'תות', 'וניל', 'שוקו', 'שוקולד', 'אפרסק', 'מנגו', 'קפה',
  'אומגה', 'אורגני', 'אורגנית', 'מלא', 'מלאה', 'חום', 'מופחת', 'מופחתת', 'דל', 'דלת', 'ללא',
  'קפוא', 'קפואה', 'קפואים', 'קפואות', 'מעושן', 'מעושנת', 'מתובל', 'מתובלת', 'טחון', 'טחונה', 'פרוס', 'פרוסה',
  'מיובש', 'מיובשים', 'קלוי', 'קלויים', 'מרוסקות', 'מרוסק', 'חתוכות', 'רסק', 'שרי', 'בייבי', 'מיני',
  'ממרח', 'רוטב', 'קמח', 'פירורי', 'עוגיות', 'קרקרים', 'צ\'יפס', 'חטיף',
  'חומץ', 'חמוץ', 'חמוצים', 'כבוש', 'כבושים', 'קוביות', 'מיובשות', 'פולפה', 'משומר', 'משומרות', 'שימורים',
  'סושי', 'ריזוטו', 'סטיקי',
]);
const MULTIPACK_WORDS = new Set(['שישייה', 'שישיה', 'שישיית', 'רביעייה', 'רביעיה', 'מארז', 'זוג', 'פחיות']);
const MULTIPACK_RE = /\d+\s*[*xX×]\s*\d/u;
// The word itself or, failing that, the word behind a one-letter prefix: "לימון" is not "ל" + "ימון".
const inSet = (set, w) => set.has(w) || set.has(bareOf(w));

const expand = (text) => EXPANSIONS.reduce((t, [re, to]) => t.replace(re, to), ` ${String(text ?? '')} `);

/** Lower-cased words of a text, with store abbreviations expanded and punctuation removed. */
export function wordsOf(text) {
  return expand(text)
    .toLocaleLowerCase()
    .replace(/["'״׳()\-,.+]/g, ' ')
    // Stores glue sizes to words ("קוביות485", "1ליטר").
    .replace(/([\u0590-\u05FF])(?=\d)|(\d)(?=[\u0590-\u05FF])/gu, '$1$2 ')
    .split(/\s+/).filter((w) => w.length >= 2 || /\d/.test(w));
}

/** A Hebrew plural's stem: בננות → בננ, תפוחים → תפוח. Short words are left alone. */
export function stemOf(word) {
  return /^[֐-׿]{3,}(ות|ים)$/u.test(word) ? word.slice(0, -2) : null;
}

const bareOf = (w) => w.replace(HEBREW_PREFIX, '');

/**
 * The words of a query that say what the product is, each with the forms it
 * may take in a product name. Numbers, sizes, units and grades are left out.
 */
export function queryTerms(query) {
  return wordsOf(query)
    .filter((w) => !/\d/.test(w) && !UNIT_WORDS.has(w) && !GRADE.test(w))
    .map((w) => {
      const bare = bareOf(w);
      // A leading ב/ה/ו may be a prefix ("בחלב") or part of the word ("בננות"), so both readings count.
      return { word: w, forms: [...new Set([w, bare, stemOf(w), stemOf(bare)].filter(Boolean))] };
    });
}

/** Whether a name word is a form of a query term: the word itself, an inflection of it, or it behind a one-letter prefix. */
export function wordMatches(term, word) {
  const bare = bareOf(word);
  return term.forms.some((f) => word.startsWith(f) || bare.startsWith(f));
}

const nameWordsOf = (item) => wordsOf(`${item.name ?? ''} ${item.brand ?? ''}`);

/** How many of the query's terms a product's name and brand contain. */
export function matchedTerms(item, terms) {
  const words = nameWordsOf(item);
  return terms.filter((t) => words.some((w) => wordMatches(t, w))).length;
}

/**
 * How well a product fits a query: the number of query terms it has, whether
 * the query's first term (usually the kind of product) is among the first two
 * words of its name, and the variant and multipack words it has that the query
 * does not ask for (`unrequested`).
 */
export function scoreOf(item, terms, query) {
  const words = wordsOf(item.name ?? '');
  const queryWords = wordsOf(query);
  const asked = new Set([...queryWords, ...queryWords.map(bareOf)]);
  const head = terms.length > 0 && words.slice(0, 2).some((w) => wordMatches(terms[0], w));
  const unrequested = words.filter((w) => inSet(VARIANT_WORDS, w) && !asked.has(w) && !asked.has(bareOf(w)));
  const asksForPack = queryWords.some((w) => inSet(MULTIPACK_WORDS, w)) || MULTIPACK_RE.test(String(query));
  if (!asksForPack) {
    const pack = words.find((w) => inSet(MULTIPACK_WORDS, w)) ?? (MULTIPACK_RE.test(item.name ?? '') ? 'multipack' : null);
    if (pack) unrequested.push(pack);
  }
  return { matched: matchedTerms(item, terms), head, penalty: unrequested.length, unrequested: [...new Set(unrequested)] };
}

/**
 * The candidates that best fit the query, in the stores' own order. A product
 * whose name does not start with the requested kind of product needs at least
 * two query words to stay ("שריר עגל בננה" is veal, not bananas). Of the rest,
 * only those matching the most query words, then those with the fewest
 * unrequested variants, then those naming the product first are kept. When even
 * those carry an unrequested variant (only Diet Coke is sold), each is marked
 * with `unrequested` so it is not passed off as what was asked for.
 */
export function bestCandidates(list, query) {
  const terms = queryTerms(query);
  if (!terms.length || !/[֐-׿]/u.test(query)) return list;
  const scored = list
    .map((item) => [item, scoreOf(item, terms, query)])
    .filter(([, s]) => s.head || s.matched >= 2);
  if (!scored.length) return [];
  const better = (a, b) => b.matched - a.matched || a.penalty - b.penalty || Number(b.head) - Number(a.head);
  const best = scored.reduce((top, [, s]) => (better(s, top) < 0 ? s : top), scored[0][1]);
  return scored.filter(([, s]) => better(s, best) === 0).map(([item, s]) => (s.unrequested.length ? { ...item, unrequested: s.unrequested } : item));
}

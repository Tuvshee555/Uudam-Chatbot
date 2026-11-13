/**
 * Words that say HOW a trip travels or WHAT KIND it is — never where it goes: a flight, a boat, a train,
 * "by land", "combined", "direct". One list for every place that has to tell a travel mode from a place:
 * trip identity (tripIdentity.ts), the unknown-place check (placeLikeTokens.ts) and place coverage
 * (placeCoverage.ts). Before it was shared, "газраар" ("by land") was a place in two of them: an ended trip's
 * text held the word, so every "<city> газраар ..." question went silent (live 2026-11-13).
 *
 * Leaf module: no imports, so any of those modules can use it without a cycle.
 */
export const ATTRIBUTE_WORDS: RegExp[] = [
  /^нис(?:э|ж|н|д|л)/u, /^онгоц/u, /^галт$/u, /^тэрэг/u, /^автобус/u, /^хосолсон/u, /^хослуул/u, /^шууд/u,
  /^газар/u, /^газрын/u, /^газраар/u, /^круз/u, /^усан$/u, /^тийз/u, /^билет/u, /^буц/u, /^хөдл/u, /^эхл/u, /^ирэх/u,
  /^nis(?:e|j|n|d|l)/u, /^ongo/u, /^galt$/u, /^tereg/u, /^avtobus/u, /^hosols/u, /^shuu?d/u, /^gazar/u, /^gazr/u,
  /^kruz/u, /^tiz/u, /^bilet/u, /^buts/u, /^hodl/u, /^ehl/u, /^irej/u,
];

export const isAttributeWord = (word: string) => ATTRIBUTE_WORDS.some((pattern) => pattern.test(word));

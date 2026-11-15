import type { Expect, Model, Scenario } from "./understandingScenarioTypes";

/** Date windows (ISO) for "every printed date must fall in here". The mocked clock is 2026-11-06. */
export const WINDOW = {
  /** Around the 2027 Tsagaan Sar (6-9 February): the holiday lists print departures near it. */
  tsagaanSar: ["2027-01-23", "2027-02-23"] as [string, string],
  /** A February 2027 ask when the nearest departures may be a few weeks off, but never November's. */
  february: ["2026-12-20", "2027-03-20"] as [string, string],
  /** New Year: departures that cover the turn of the year. */
  newYear: ["2026-12-20", "2027-01-10"] as [string, string],
} as const;

/** The mocked understanding model when it does not help at all (the raw harness default is a price topic). */
export const NO_HELP: Model = { intent: "other", topics: [], certainty: "none" };

/**
 * Copies a scenario with other customer wording for chosen turns (turn index -> text), so one
 * expectation set is asked in several unseen ways. Ids become "<id>.<suffix>".
 */
export function reworded(base: Scenario, suffix: string, texts: Record<number, string>, extraTags: string[] = ["paraphrase"]): Scenario {
  return {
    ...base,
    id: `${base.id}.${suffix}`,
    tags: [...new Set([...base.tags, ...extraTags])],
    turns: base.turns.map((turn, index) => (texts[index] === undefined ? turn : { ...turn, text: texts[index] })),
  };
}

/** One unseen wording per entry, replacing the turn at `index` (default: the last turn). */
export function paraphrases(base: Scenario, texts: string[], index = base.turns.length - 1, prefix = "p"): Scenario[] {
  return texts.map((text, position) => reworded(base, `${prefix}${position + 1}`, { [index]: text }));
}

/** The same scenario under another model behaviour, with its tags extended. */
export function underModel(base: Scenario, suffix: string, model: Model, extraTags: string[] = [], turns?: number[]): Scenario {
  return {
    ...base,
    id: `${base.id}.${suffix}`,
    tags: [...new Set([...base.tags, ...extraTags])],
    model: turns ? base.model : model,
    turns: turns ? base.turns.map((turn, index) => (turns.includes(index) ? { ...turn, model } : turn)) : base.turns.map((turn) => ({ ...turn, model: undefined })),
  };
}

export const merge = (...parts: Expect[]): Expect => Object.assign({}, ...parts) as Expect;

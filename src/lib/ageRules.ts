/**
 * Per-trip passenger age bands: who counts as an infant, a child, an adult.
 *
 * Every trip can differ ("1-23 сар нярай, 2-6 нас хүүхэд, 7+ том хүн" on one,
 * "0-2 / 2-11 / 12+" on another), so the bands are stored on the trip in
 * `extra.age_rules` and edited in the admin. The defaults below only pre-fill
 * the form for a trip that has none yet — they are never quoted to a customer
 * until an admin has saved them onto that trip.
 *
 * Pure: no DB, no env, importable from the browser and the server.
 */

export type AgeRules = { infant: string; child: string; adult: string };

export const DEFAULT_AGE_RULES: AgeRules = {
  infant: "0-23 сар",
  child: "2-11 нас",
  adult: "12+ нас",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Exactly what the admin saved — empty strings where nothing is set. */
export function ageRulesFromExtra(extra: Record<string, unknown> | null | undefined): AgeRules {
  const raw = (extra?.age_rules && typeof extra.age_rules === "object"
    ? extra.age_rules
    : {}) as Record<string, unknown>;
  return { infant: text(raw.infant), child: text(raw.child), adult: text(raw.adult) };
}

/** True once an admin has saved at least one band on this trip. */
export function hasAgeRules(extra: Record<string, unknown> | null | undefined): boolean {
  const rules = ageRulesFromExtra(extra);
  return Boolean(rules.infant || rules.child || rules.adult);
}

/** Form pre-fill: saved bands, with the defaults standing in for empty ones. */
export function resolveAgeRules(extra: Record<string, unknown> | null | undefined): AgeRules {
  const saved = ageRulesFromExtra(extra);
  return {
    infant: saved.infant || DEFAULT_AGE_RULES.infant,
    child: saved.child || DEFAULT_AGE_RULES.child,
    adult: saved.adult || DEFAULT_AGE_RULES.adult,
  };
}

/** "Нярай (0-23 сар)" — label with its band, when the band is known. */
export function labelWithAge(label: string, band: string): string {
  return band ? `${label} (${band})` : label;
}

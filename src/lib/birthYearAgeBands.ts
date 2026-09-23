/**
 * Passenger tiers that are defined by BIRTH YEAR ("ХҮҮХЭД -2014-2015 ОН",
 * "НЯРАЙ 2024-2026") rather than by age.
 *
 * The poster mapper used to read an age band out of those labels with
 * `(\d{1,2})-(\d{1,2})`, which finds "14-20" inside "2014-2015". Saved trips
 * therefore carry bands such as "14-20 нас" (child), "16-20 нас" and
 * "24-20 нас" (infant) — and the bot quoted "Хүүхэд /14-20 нас/" to real
 * customers, telling them 19-year-olds travel at the child fare.
 *
 * Kept dependency-free so the mapper (future syncs) and the customer-facing
 * sanitizer (data already saved) share one definition.
 */

const BIRTH_YEAR_RANGE = /(?<!\d)((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2})(?!\d)/;

/** "ХҮҮХЭД -2014-2015 ОН" → "2014-2015 он"; null when the label has no birth years. */
export function birthYearBand(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const match = BIRTH_YEAR_RANGE.exec(label);
  if (!match) return null;
  const [low, high] = [Number(match[1]), Number(match[2])].sort((a, b) => a - b);
  return `${low}-${high} он`;
}

/**
 * The band the old mapper derived from a birth-year label ("2014-2015 ОН" →
 * "14-20 нас"). Used only to recognise that exact misreading in saved data, so
 * a band an operator typed on purpose is never overwritten.
 */
export function misreadBirthYearBand(label: unknown): string | null {
  if (typeof label !== "string" || !birthYearBand(label)) return null;
  const range = label.match(/(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(нас|сар|age)?/i);
  if (!range) return null;
  const unit = /сар/i.test(range[3] || "") || /сар/i.test(label) ? "сар" : "нас";
  return `${Number(range[1])}-${Number(range[2])} ${unit}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** One passenger tier ({ label, age_range }) with a misread band restored. */
function repairTier(entry: unknown, fixes: Map<string, string>): unknown {
  if (!isRecord(entry)) return entry;
  const band = birthYearBand(entry.label);
  if (!band) return entry;
  const range = typeof entry.age_range === "string" ? entry.age_range.trim() : "";
  const misread = misreadBirthYearBand(entry.label);
  if (misread) fixes.set(misread, band);
  if (range === band) return entry;
  if (range && range !== misread) return entry;
  return { ...entry, age_range: band };
}

function repairTierList(list: unknown, fixes: Map<string, string>): unknown {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const next = list.map((entry) => {
    const fixed = repairTier(entry, fixes);
    if (fixed !== entry) changed = true;
    return fixed;
  });
  return changed ? next : list;
}

function repairBand(value: unknown, fixes: Map<string, string>): unknown {
  return typeof value === "string" && fixes.has(value.trim()) ? fixes.get(value.trim()) : value;
}

/**
 * Restores birth-year bands everywhere a trip's `extra` stores passenger tiers
 * (price groups, child rules, age rules). Pure; returns the same object when
 * nothing needed repair.
 */
export function repairBirthYearAgeBands(extra: Record<string, unknown>): Record<string, unknown> {
  const fixes = new Map<string, string>();
  let next = extra;
  const set = (key: string, value: unknown) => {
    if (value === extra[key]) return;
    if (next === extra) next = { ...extra };
    next[key] = value;
  };

  for (const key of ["child_rules", "child_price_rules"]) {
    set(key, repairTierList(extra[key], fixes));
  }
  for (const key of ["price_groups", "departure_date_groups"]) {
    const groups = extra[key];
    if (!Array.isArray(groups)) continue;
    let changed = false;
    const repaired = groups.map((group) => {
      if (!isRecord(group)) return group;
      const passengers = repairTierList(group.passenger_prices, fixes);
      const childAge = repairBand(group.child_age, fixes);
      const infantAge = repairBand(group.infant_age, fixes);
      if (passengers === group.passenger_prices && childAge === group.child_age && infantAge === group.infant_age) {
        return group;
      }
      changed = true;
      return { ...group, passenger_prices: passengers, child_age: childAge, infant_age: infantAge };
    });
    if (changed) set(key, repaired);
  }
  if (isRecord(extra.age_rules) && fixes.size > 0) {
    const rules = extra.age_rules;
    const repaired = {
      ...rules,
      infant: repairBand(rules.infant, fixes),
      child: repairBand(rules.child, fixes),
      adult: repairBand(rules.adult, fixes),
    };
    if (repaired.infant !== rules.infant || repaired.child !== rules.child || repaired.adult !== rules.adult) {
      set("age_rules", repaired);
    }
  }
  return next;
}

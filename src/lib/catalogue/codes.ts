/**
 * Stable trip codes ("A01" .. "A99", "B01" ..), allocated once per trip id and then never changed.
 *
 *   seq 1..99    -> A01..A99
 *   seq 100..198 -> B01..B99
 *   ...up to Z99 (seq 2574)
 *
 * The code is shared by every edition. A trip that disappears keeps its row, so its code is never
 * handed to another trip: a customer who saved "A04" a year ago must never get a different trip.
 *
 * Allocation runs under a transaction-scoped advisory lock, so concurrent callers (two admin tabs,
 * the generator and a webhook) serialise and never collide; the UNIQUE(seq) and UNIQUE(code)
 * constraints are the backstop, and a unique violation retries the whole transaction.
 */
import {
  CatalogueStoreError,
  catalogueNowIso,
  catalogueQuery,
  catalogueTransaction,
  isUniqueViolation,
  writeAudit,
} from "./schema";

const PER_LETTER = 99;
const LETTERS = 26;
export const CATALOGUE_MAX_TRIP_CODES = PER_LETTER * LETTERS;
const MAX_ALLOCATION_RETRIES = 4;
const TRIP_ID_RE = /^[^\s\u0000-\u001f\u007f]{1,160}$/u;

/** seq (1-based) -> "A01". Throws when the code space is exhausted. */
export function codeForSeq(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new CatalogueStoreError("invalid_input", "Trip code sequence must be >= 1");
  if (seq > CATALOGUE_MAX_TRIP_CODES) {
    throw new CatalogueStoreError("code_space_exhausted", "No trip codes left");
  }
  const letter = String.fromCharCode(65 + Math.floor((seq - 1) / PER_LETTER));
  const number = ((seq - 1) % PER_LETTER) + 1;
  return `${letter}${String(number).padStart(2, "0")}`;
}

/** "B01" -> 100. Null when the text is not a canonical code. */
export function seqForCode(code: string): number | null {
  const match = /^([A-Z])(\d{2})$/.exec(code);
  if (!match) return null;
  const number = Number(match[2]);
  if (number < 1 || number > PER_LETTER) return null;
  return (match[1].charCodeAt(0) - 65) * PER_LETTER + number;
}

// Cyrillic capitals that look like the Latin code letters. People typing on a Cyrillic keyboard
// produce them without noticing ("А01" is not "A01" to a database).
const CYRILLIC_LOOKALIKES: Record<string, string> = {
  "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "К": "K", "М": "M", "О": "O", "Р": "P", "Т": "T", "Х": "X",
};

/**
 * What a customer typed -> canonical code or null. Accepts "a1", "A-01", "A 01", "А01" (Cyrillic).
 * Pure.
 */
export function normalizeTripCode(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .trim()
    .toUpperCase()
    .replace(/[АВСЕНКМОРТХ]/g, (ch) => CYRILLIC_LOOKALIKES[ch] ?? ch);
  const match = /^([A-Z])[\s\-_.]?(\d{1,2})$/.exec(text);
  if (!match) return null;
  const number = Number(match[2]);
  if (number < 1 || number > PER_LETTER) return null;
  return `${match[1]}${String(number).padStart(2, "0")}`;
}

function cleanTripIds(tripIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tripIds) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!TRIP_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

type CodeRow = { trip_id: string; code: string };

/**
 * Codes for every given trip id, allocating the missing ones in the order given. Idempotent:
 * asking again returns the same codes. Concurrency-safe.
 */
export async function assignTripCodes(tripIds: readonly string[]): Promise<Record<string, string>> {
  const ids = cleanTripIds(tripIds);
  if (ids.length === 0) return {};

  // Fast path: everything already has a code, no transaction needed.
  const known = await catalogueQuery<CodeRow>(
    `/* cat:codes_by_trip */ SELECT trip_id, code FROM catalogue_codes WHERE trip_id = ANY($1::text[])`,
    [ids],
  );
  const map: Record<string, string> = {};
  for (const row of known.rows) map[row.trip_id] = row.code;
  if (ids.every((id) => map[id])) return pick(map, ids);

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ALLOCATION_RETRIES; attempt++) {
    try {
      return await allocate(ids);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("trip code allocation failed");
}

async function allocate(ids: string[]): Promise<Record<string, string>> {
  return catalogueTransaction(async (query) => {
    await query(`/* cat:codes_lock */ SELECT pg_advisory_xact_lock(hashtext($1))`, ["catalogue_codes"]);
    const existing = await query<CodeRow>(
      `/* cat:codes_by_trip */ SELECT trip_id, code FROM catalogue_codes WHERE trip_id = ANY($1::text[])`,
      [ids],
    );
    const map: Record<string, string> = {};
    for (const row of existing.rows) map[row.trip_id] = row.code;
    const missing = ids.filter((id) => !map[id]);
    if (missing.length === 0) return pick(map, ids);

    const max = await query<{ max_seq: number | string | null }>(
      `/* cat:codes_max_seq */ SELECT MAX(seq) AS max_seq FROM catalogue_codes`,
    );
    let seq = Number(max.rows[0]?.max_seq ?? 0);
    const assignedAt = catalogueNowIso();
    const created: string[] = [];
    for (const tripId of missing) {
      seq += 1;
      const code = codeForSeq(seq);
      await query(
        `/* cat:codes_insert */ INSERT INTO catalogue_codes (trip_id, seq, code, assigned_at)
         VALUES ($1,$2,$3,$4::timestamptz)`,
        [tripId, seq, code, assignedAt],
      );
      map[tripId] = code;
      created.push(code);
    }
    await writeAudit(query, { action: "code_assign", actor: null, detail: { count: created.length, first: created[0] ?? null } });
    return pick(map, ids);
  });
}

function pick(map: Record<string, string>, ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = map[id];
  return out;
}

/** Every assigned code, trip id -> code. */
export async function getTripCodeMap(): Promise<Record<string, string>> {
  const result = await catalogueQuery<CodeRow>(
    `/* cat:codes_all */ SELECT trip_id, code FROM catalogue_codes ORDER BY seq ASC`,
  );
  const map: Record<string, string> = {};
  for (const row of result.rows) map[row.trip_id] = row.code;
  return map;
}

/** "a01" / "А01" / "A-1" -> trip id, or null when the text is no code or no trip owns it. */
export async function resolveTripCode(code: string): Promise<string | null> {
  const normalized = normalizeTripCode(code);
  if (!normalized) return null;
  const result = await catalogueQuery<{ trip_id: string }>(
    `/* cat:codes_resolve */ SELECT trip_id FROM catalogue_codes WHERE code = $1`,
    [normalized],
  );
  return result.rows[0]?.trip_id ?? null;
}

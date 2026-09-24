#!/usr/bin/env node
/**
 * Golden-question QA harness — run BEFORE going live and AFTER every data upload.
 *
 * Builds customer-style questions from the live catalog, sends them to a running demo endpoint
 * and flags any reply that trips a red flag (a past date, an invented value, an
 * internal marker leak, a scolding phrase, the wrong staff title, etc.).
 *
 * Usage:
 *   npm run dev                       # in one terminal (serves /api/demo)
 *   node scripts/golden-questions.mjs # in another
 *
 * Config via env:
 *   DEMO_URL   full demo endpoint (default http://localhost:3004/api/demo)
 *
 * This is a MANUAL/CI smoke tool against a live server with real trip data —
 * it is intentionally NOT part of `npm test` (that layer is covered
 * deterministically by tests/golden-red-flags.test.ts).
 */

import pg from "pg";

const DEMO_URL = process.env.DEMO_URL || "http://localhost:3004/api/demo";

// ── Questions are built from the LIVE catalog at run time ───────────────────
// Never write a real trip name, price or date into this file: the catalog
// changes every week and a hardcoded question goes stale (or, worse, passes
// against a trip that no longer exists). The code only knows the SHAPE of a
// question; the database supplies the places.

const GENERIC_NAME_WORDS = new Set([
  "аялал", "аяллын", "аялалд", "шууд", "нислэг", "нислэгтэй", "газар", "газрын", "хосолсон",
  "хотын", "сарын", "хөтөлбөр", "амралт", "амралтаар", "амралтын", "сурагчдын", "буюу", "болон",
  "өдөр", "шөнө", "хотод", "хот", "аяллууд",
]);
// Used for the "not in the catalog" check — an invented place, never a real one.
const INVENTED_PLACE = "Вэлмор";

async function loadActiveTripNames() {
  const connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("NEON_DATABASE_URL is required: questions are built from the live catalog.");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const client = new pg.Client({ connectionString, ssl: local ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query("select route_name from travel_trip_entries where status = 'active'");
    return rows.map((row) => String(row.route_name || "")).filter(Boolean);
  } finally {
    await client.end();
  }
}

function nameWords(name) {
  return Array.from(new Set(
    name.split(/[^\p{L}]+/u).filter((word) => word.length >= 4 && !GENERIC_NAME_WORDS.has(word.toLowerCase())),
  ));
}

function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

const LATIN = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", ө: "u", п: "p", р: "r", с: "s", т: "t", у: "u", ү: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sh", ъ: "", ы: "ii", ь: "i", э: "e", ю: "yu", я: "ya",
};
const toLatin = (word) => [...word.toLowerCase()].map((c) => LATIN[c] ?? c).join("");

function buildQuestions(names) {
  const tripsByWord = new Map();
  for (const name of names) {
    for (const word of nameWords(name)) {
      const key = word.toLowerCase();
      tripsByWord.set(key, [...(tripsByWord.get(key) || []), name]);
    }
  }
  const byCount = [...tripsByWord.entries()].sort((a, b) => b[1].length - a[1].length);
  const shared = byCount.find(([, trips]) => trips.length >= 2)?.[0];
  const singles = byCount.filter(([, trips]) => trips.length === 1).map(([word]) => word);
  const single = singles[0];
  // A different trip AND a different-looking word — not the same place spelled twice.
  const other = singles.find(
    (word) => tripsByWord.get(word)[0] !== tripsByWord.get(single)?.[0] && word.slice(0, 4) !== single?.slice(0, 4),
  );
  if (!shared || !single || !other) throw new Error("Catalog too small to build the golden questions.");
  const Shared = titleCase(shared);
  const Single = titleCase(single);
  const Other = titleCase(other);

  return [
    { id: "shared-destination", text: Shared, note: `"${Shared}" is in several trips → must ask which, no phone ask`, expectAny: ["Аль аяллыг"] },
    { id: "shared-broad-price", text: `${Shared} аялал хэд вэ?`, note: "broad price question on a shared destination → clarify, not silence", expectAny: ["Аль аяллыг"] },
    { id: "single-price", text: `${Single} аялал үнэ хэд вэ?`, note: "one trip → its price", expectAny: ["₮"], allowSilent: true },
    { id: "year-boundary", text: "1 сарын 15-нд гарах аялал байгаа юу?", note: "must not offer a past January date", allowSilent: true },
    { id: "specific-month", text: "7 сард ямар аялал байна?", note: "only that month's departures", allowSilent: true },
    { id: "seats", text: `${Single} суудал байгаа юу?`, note: "no invented seat count", allowSilent: true },
    { id: "visa", text: "Виз хэрэгтэй юу?", note: "REFER unless stored — no invented visa info", allowSilent: true },
    { id: "not-in-db", text: `${INVENTED_PLACE} аялал байна уу?`, note: "place not in catalog → no invented trip", allowSilent: true, reject: names },
    { id: "translit", text: `${toLatin(single)} une`, note: "Latin spelling should still match", allowSilent: true },
    { id: "greeting", text: "Сайн байна уу", note: "greeting once, friendly" },
    { id: "discount", text: "Хямдрал байгаа юу?", note: "only real discounts from data", allowSilent: true },
    { id: "recommend", text: "Хүүхэдтэй гэр бүлд ямар аялал тохирох вэ?", note: "recommend 1-2, not the whole list", allowSilent: true },
    { id: "compare", text: `${Single} уу ${Other} уу, аль нь дээр вэ?`, note: "clear comparison", expectAny: ["харьцуулалт", "Харьцуулалт"], reject: ["Энэ чиглэлээр хэд хэдэн сонголт"] },
    // A generic objection names no trip; answering with one is a false match.
    { id: "expensive", text: "Үнэтэй юм байна", note: "objection handling, no trip picked out of thin air", reject: names },
    {
      id: "phone-then-question",
      text: `${Shared} аяллын үнэ хэд вэ?`,
      follow: [
        { text: "99112233", expectAny: ["Баярлалаа", "99112233"], reject: ["Аль аяллыг"] },
        { text: "Хэдэн өдрийн аялал вэ?", reject: ["Утасны дугаараа", "дугаараа үлдээ"], allowSilent: true },
      ],
      note: "after phone given, must NOT ask for phone again",
    },
    { id: "repeat", text: `${Shared} аяллын үнэ хэд вэ?`, follow: [`${Shared} аяллын үнэ хэд вэ?`], note: "no scolding on repeat" },
    { id: "landline", text: "Манай оффис 77136633 руу залгаарай гэсэн үү?", note: "77136633 is a landline — must NOT be treated as a lead phone", allowSilent: true },
  ];
}

// A red flag = a substring that should NEVER appear in a customer-facing reply.
// `strip` (optional) removes legitimate text before the pattern is tested —
// used where a heuristic would otherwise misfire on valid data.
const RED_FLAGS = [
  { pattern: /\bREFER\b/, label: "raw REFER token leaked" },
  { pattern: /\bSILENT\b/, label: "raw SILENT token leaked" },
  { pattern: /NEEDS_MANUAL_FIX/, label: "NEEDS_MANUAL_FIX sentinel leaked" },
  { pattern: /Varies by departure date|Travel category/, label: "English placeholder leaked" },
  { pattern: /\b(JSON|database|source_description|record)\b/i, label: "internal field/word leaked" },
  { pattern: /өмнө нь (хэлсэн|хуваалцсан)|as I mentioned|already (told|shared)/i, label: "scolding repeat phrase" },
  { pattern: /хүний нөөцийн менежер/i, label: "wrong staff title (HR, not travel consultant)" },
  {
    pattern: /\b20(1\d|2[0-4])\b/,
    // Child prices are defined by birth-year eligibility ranges in the trip
    // data (e.g. "2016-2023 он" = born 2016-2023). Reciting that range is
    // correct — only a lone past year offered as a date is a red flag.
    strip: /\b20\d{2}\s*[-–—]\s*20\d{2}(\s*он[ды]?)?/g,
    label: "past year (<=2024) offered as a date",
  },
];

function makeConversationId(id) {
  // 16-80 chars, [a-zA-Z0-9_-]
  return `golden-${id}-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80).padEnd(16, "0");
}

async function ask(text, conversationId) {
  const res = await fetch(DEMO_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-uudam-demo-qa": "1",
    },
    body: JSON.stringify({ text, conversationId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return typeof json.reply === "string" ? json.reply : JSON.stringify(json);
}

function checkRedFlags(reply) {
  return RED_FLAGS.filter((flag) => {
    const haystack = flag.strip ? reply.replace(flag.strip, "") : reply;
    return flag.pattern.test(haystack);
  }).map((flag) => flag.label);
}

function normalizeTurnSpec(question, turn, followIndex) {
  if (followIndex === -1) {
    const first = { ...question };
    delete first.follow;
    delete first.note;
    delete first.id;
    return first;
  }
  return typeof turn === "string" ? { text: turn } : turn;
}

function checkTurnExpectations(reply, turn) {
  const failures = [];
  if (!turn.allowSilent && !reply.trim()) {
    failures.push("unexpected empty/silent reply");
  }
  if (Array.isArray(turn.expectAny) && turn.expectAny.length > 0) {
    const matched = turn.expectAny.some((needle) => reply.includes(needle));
    if (!matched) failures.push(`missing any of: ${turn.expectAny.join(" | ")}`);
  }
  for (const needle of turn.reject || []) {
    if (reply.includes(needle)) failures.push(`unexpected: ${needle}`);
  }
  return failures;
}

async function main() {
  console.log(`Golden-question QA → ${DEMO_URL}\n`);
  const QUESTIONS = buildQuestions(await loadActiveTripNames());
  let failures = 0;
  let checks = 0;

  for (const q of QUESTIONS) {
    const conversationId = makeConversationId(q.id);
    const turns = [
      normalizeTurnSpec(q, q.text, -1),
      ...(q.follow || []).map((turn, index) => normalizeTurnSpec(q, turn, index)),
    ];
    console.log(`\n■ ${q.id} — ${q.note}`);
    for (const turn of turns) {
      checks += 1;
      try {
        const reply = await ask(turn.text, conversationId);
        const flags = checkRedFlags(reply);
        const expectationFailures = checkTurnExpectations(reply, turn);
        const preview = reply.replace(/\n/g, " ⏎ ").slice(0, 160);
        if (flags.length || expectationFailures.length) {
          failures += 1;
          const allFailures = [
            ...flags.map((flag) => `RED FLAG: ${flag}`),
            ...expectationFailures,
          ];
          console.log(`  ✖ "${turn.text}"\n    ${preview}\n    FAILURES: ${allFailures.join("; ")}`);
        } else {
          console.log(`  ✓ "${turn.text}" → ${preview}`);
        }
      } catch (error) {
        failures += 1;
        console.log(`  ✖ "${turn.text}" — request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`${checks} checks, ${failures} red-flag/failed.`);
  console.log("Manual review still required for accuracy (right trip, right price).");
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

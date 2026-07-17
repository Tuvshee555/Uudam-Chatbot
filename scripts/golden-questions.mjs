#!/usr/bin/env node
/**
 * Golden-question QA harness — run BEFORE going live and AFTER every data upload.
 *
 * Sends a fixed set of real-world customer questions to a running demo endpoint
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

const DEMO_URL = process.env.DEMO_URL || "http://localhost:3004/api/demo";

// Each entry is one fresh conversation. `follow` messages run in the same
// conversation, in order, to test multi-turn behaviour (e.g. no re-ask after a
// phone number is given).
const QUESTIONS = [
  { id: "beijing-ambiguous", text: "Бээжин", note: "should ask which of the Beijing variants (clarify), no phone ask" },
  { id: "beijing-broad-price", text: "Бээжин аялал хэд вэ?", note: "known broad Beijing price question should clarify, not go silent" },
  { id: "beijing-direct-flight", text: "Бээжин шууд нислэгтэй үнэ хэд вэ?", note: "one trip, adult+child price" },
  { id: "beijing-land", text: "нислэггүй Бээжин аялал", note: "land trip only" },
  { id: "year-boundary", text: "1 сарын 15-нд гарах аялал байгаа юу?", note: "must not offer a past January date" },
  { id: "specific-month", text: "7 сард ямар аялал байна?", note: "only July departures" },
  { id: "seats", text: "Хайнан суудал байгаа юу?", note: "no invented seat count" },
  { id: "visa", text: "Виз хэрэгтэй юу?", note: "REFER unless stored — no invented visa info" },
  { id: "not-in-db", text: "Токио аялал байна уу?", note: "not in catalog → polite consultant handoff" },
  { id: "translit", text: "beidaihe une", note: "transliteration should still match" },
  { id: "greeting", text: "Сайн байна уу", note: "greeting once, friendly" },
  { id: "discount", text: "Хямдрал байгаа юу?", note: "only real discounts from data" },
  { id: "recommend", text: "Хүүхэдтэй гэр бүлд ямар аялал тохирох вэ?", note: "recommend 1-2, not the whole list" },
  { id: "compare", text: "Бээжин уу Хайнан уу, аль нь дээр вэ?", note: "clear comparison" },
  { id: "expensive", text: "Үнэтэй юм байна", note: "objection handling, not pushy, no invented discount" },
  {
    id: "phone-then-question",
    text: "Бээжин аяллын үнэ хэд вэ?",
    follow: ["99112233", "Хэдэн өдрийн аялал вэ?"],
    note: "after phone given, must NOT ask for phone again",
  },
  { id: "repeat", text: "Бээжин аяллын үнэ хэд вэ?", follow: ["Бээжин аяллын үнэ хэд вэ?"], note: "no scolding on repeat" },
  { id: "landline", text: "Манай оффис 77136633 руу залгаарай гэсэн үү?", note: "77136633 is a landline — must NOT be treated as a lead phone" },
];

const QUESTION_ASSERTIONS = {
  // These are true unknown/no-data checks under the current lead-preservation
  // policy: customer-side silence is allowed, but leaking REFER/SILENT is not.
  "beijing-direct-flight": { allowSilent: true },
  "beijing-broad-price": {
    expectAny: ["Аль аяллыг", "БЭЭЖИН", "Бэйдайхэ"],
  },
  "year-boundary": { allowSilent: true },
  visa: { allowSilent: true },
  handoff: { allowSilent: true },

  // A generic objection must not route-match the unrelated Jinin route whose
  // name contains "үнэтэй шинжилгээтэй".
  expensive: {
    reject: ["Жинин", "шинжилгээтэй"],
  },
  compare: {
    expectAny: ["харьцуулалт", "Харьцуулалт"],
    reject: ["Энэ чиглэлээр хэд хэдэн сонголт"],
  },

  // The second turn is the customer leaving a phone number. Demo and Messenger
  // must both acknowledge it, not answer the previous trip question again.
  "phone-then-question": {
    follow: {
      0: {
        expectAny: ["Баярлалаа", "99112233"],
        reject: ["Аль аяллыг", "БЭЭЖИН", "Бэйдайхэ"],
      },
      1: {
        reject: ["Утасны дугаараа", "дугаараа үлдээ"],
      },
    },
  },
};

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
    headers: { "content-type": "application/json" },
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
  const base = typeof turn === "string" ? { text: turn } : turn;
  const assertions = QUESTION_ASSERTIONS[question.id] || {};
  const override = followIndex === -1
    ? assertions
    : (assertions.follow || {})[followIndex] || {};
  return { ...base, ...override };
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

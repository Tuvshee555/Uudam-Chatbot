#!/usr/bin/env node
/**
 * 100-turn local demo QA.
 *
 * Runs real HTTP requests against /api/demo with a local-dev-only QA header so
 * this exercises the same endpoint staff use without waiting for rate limits.
 *
 * Usage:
 *   npm run dev
 *   node scripts/qa-100-demo.mjs
 */

const DEMO_URL = process.env.DEMO_URL || "http://localhost:3004/api/demo";
const RUN_ID = Date.now().toString(36);

const RED_FLAGS = [
  { label: "raw REFER leaked", pattern: /\bREFER\b/ },
  { label: "raw SILENT leaked", pattern: /\bSILENT\b/ },
  { label: "internal sentinel leaked", pattern: /NEEDS_MANUAL_FIX|source_description|travel_trip_entries|database/i },
  { label: "English placeholder leaked", pattern: /Varies by departure date|Travel category/i },
  { label: "wrong staff title", pattern: /хүний нөөцийн менежер/i },
  { label: "repeat scold", pattern: /өмнө нь хэлсэн|as I mentioned|already told/i },
];

const singles = [
  { id: "beijing-broad", text: "Бээжин аялал хэд вэ?", expectAny: ["Аль аяллыг", "БЭЭЖИН"] },
  { id: "beijing-land", text: "Бээжин газрын аялал хэд вэ?", reject: ["Бэйдайхэ"] },
  { id: "beijing-direct", text: "Бээжин шууд нислэгтэй аялал байна уу?" },
  { id: "beijing-combo", text: "Бээжин газар нислэг хосолсон аяллын үнэ?" },
  { id: "beidaihe-price", text: "Бэйдайхэ үнэ?", expectAny: ["БЭЙДАЙХЭ", "Бэйдайхэ"] },
  { id: "beidaihe-land", text: "Бэйдайхэ газрын аялал үнэ?", reject: ["2,150,000"] },
  { id: "beidaihe-combo", text: "Бэйдайхэ газар нислэг хосолсон үнэ?", expectAny: ["2,150,000", "хосолсон"] },
  { id: "shanghai-info", text: "shanghai aylal medeelel awy", expectAny: ["Шанхай", "Аль аяллыг"] },
  { id: "shanghai-direct", text: "Шанхай шууд нислэгтэй үнэ?" },
  { id: "shanghai-waterpark", text: "Шанхай усан парктай аялал?", expectAny: ["усан", "Ханжоу"] },
  { id: "shanghai-tenger", text: "Шанхай Тэнгэрийн хаалга үнэ?", expectAny: ["Тэнгэрийн хаалга"] },
  { id: "hainan-broad", text: "Хайнан сонирхож байна" },
  { id: "hainan-sanya", text: "Хайнан Саньяа үнэ?", expectAny: ["Саньяа"] },
  { id: "hainan-haikou", text: "Хайнан Хайкоу үнэ?", expectAny: ["Хайкоу"] },
  { id: "tenger-broad", text: "Тэнгэрийн хаалга хэд вэ?" },
  { id: "tenger-direct", text: "Тэнгэрийн хаалга шууд нислэгтэй хэд вэ?", expectAny: ["2,990,000", "шууд"] },
  { id: "tenger-combo", text: "Тэнгэрийн хаалга газар нислэгтэй хэд вэ?", expectAny: ["2,770,000", "газар"] },
  { id: "jining-broad", text: "Жинин аялал хэд вэ?" },
  { id: "jining-mini", text: "Жинин Мини аватар үнэ?" },
  { id: "hohhot-exam", text: "Хөх хот шинжилгээтэй аялал хэд вэ?", expectAny: ["CNY", "шинжилгээ"] },
  { id: "jeju", text: "Жэжү шууд нислэгтэй аялал хэд вэ?", expectAny: ["Жэжү"] },
  { id: "tokyo", text: "Токио Фүжи аяллын үнэ?", expectAny: ["Токио"] },
  { id: "tokyo-ticket", text: "Токио тийзтэй үнэ?", expectAny: ["тийзтэй"] },
  { id: "tokyo-ticketless", text: "Токио тийзгүй үнэ?", expectAny: ["тийзгүй"] },
  { id: "dalian", text: "Далянь аялал хэд вэ?", expectAny: ["Далянь"] },
  { id: "hailaar", text: "Хайлаар Манжуур аялал?" },
  { id: "hailaar-4", text: "Хайлаар 4 өдөр үнэ?", expectAny: ["4 өдөр", "4 шөнө"] },
  { id: "hailaar-5", text: "Хайлаар 5 өдөр үнэ?", expectAny: ["5 өдөр", "5 шөнө"] },
  { id: "chongqing", text: "Чунчин аялал үнэ?" },
  { id: "macau", text: "Макао Жухай Хайлин арал үнэ?", expectAny: ["Макао"] },
  { id: "guangzhou", text: "Гуанжоу Макао Шэнжин үнэ?", expectAny: ["Гуанжоу"] },
  { id: "cruise", text: "Усан онгоцны аялал Чежү Пусан хэд вэ?", expectAny: ["Усан онгоц", "Пусан"] },
  { id: "july-price", text: "7 сарын аяллын үнэ л хэлээд өг" },
  { id: "august-price", text: "8 сарын аяллын үнэ" },
  { id: "past-date-no-context", text: "6 сарын 27-ны үнэ хэд вэ?", reject: ["7 сарын 9-нд гарах"] },
  { id: "beidaihe-july-9", text: "Бэйдайхэ 7 сарын 9 хэд вэ?", expectAny: ["7 сарын 9", "2,150,000", "1,390,000"] },
  { id: "beidaihe-aug-child", text: "Бэйдайхэ 8 сарын 1 хүүхдийн үнэ", expectAny: ["хүүхэд", "1,710,000"] },
  { id: "beidaihe-past-date", text: "Бэйдайхэ 6 сарын 27 үнэ", reject: ["7 сарын 9"] },
  { id: "shanghai-aug-6", text: "Шанхай 8 сарын 6 үнэ", expectAny: ["8 сарын 6", "3,160,000"] },
  { id: "hailaar-aug-24", text: "Хайлаар 8 сарын 24 үнэ", expectAny: ["Аль аяллыг", "Хайлаар Манжуур"] },
  { id: "tomorrow", text: "маргааш явах аялал байна уу" },
  { id: "today", text: "өнөөдөр гарах аялал байна уу" },
  { id: "july-availability", text: "7 сард явах аялал байна уу" },
  { id: "august-availability", text: "8 сард явах аялал байна уу" },
  { id: "beidaihe-infant", text: "Бэйдайхэ нярай хэд вэ?", expectAny: ["Нярай", "530,000"], reject: ["Жинин", "шинжилгээ"] },
  { id: "beidaihe-child", text: "Бэйдайхэ хүүхдийн үнэ", expectAny: ["Хүүхэд", "1,190,000", "1,710,000"] },
  { id: "sanya-age-2", text: "Хайнан Саньяа 2 настай хүүхэд хэд вэ?", expectAny: ["2-6", "2,190,000"] },
  { id: "sanya-age-7", text: "Хайнан Саньяа 7 настай хүүхэд хэд вэ?", expectAny: ["6-12", "2,790,000"] },
  { id: "beidaihe-total-natural", text: "том хүн 2 хүүхэд 1 Бэйдайхэ нийт хэд вэ", expectAny: ["3,970,000"] },
  { id: "beidaihe-total-clear", text: "Бэйдайхэ 2 том 1 хүүхэд нийт хэд вэ", expectAny: ["3,970,000"] },
  { id: "beidaihe-photo", text: "Бэйдайхэ газар нислэг хосолсон зураг", requireMedia: true },
  { id: "shanghai-photo", text: "Шанхай Тэнгэрийн хаалга зураг явуулаач", requireMedia: true },
  { id: "hainan-photo", text: "Хайнан Саньяа зураг" },
  { id: "beijing-program", text: "Бээжин хөтөлбөр" },
  { id: "shanghai-program", text: "Шанхай Жанжиажэ хөтөлбөр" },
  { id: "pdf-no-trip", text: "PDF явуул" },
  { id: "beidaihe-seats", text: "суудал байна уу Бэйдайхэ" },
  { id: "hainan-seats", text: "Хайнан суудал байгаа юу" },
  { id: "discount-broad", text: "хямдралтай үнэ байгаа юу" },
  { id: "dalian-discount", text: "Далянь хямдралтай юу", expectAny: ["Далянь", "хямд"] },
  { id: "cheapest", text: "хамгийн хямд аялал юу байна" },
  { id: "cheapest-direct", text: "хамгийн хямд шууд нислэгтэй аялал?" },
  { id: "under-3m", text: "3 саяас доош аялал байна уу" },
  { id: "price-2990", text: "2,990,000 гэсэн аялал аль вэ?", expectAny: ["2,990,000", "Тэнгэрийн хаалга"] },
  { id: "visa", text: "виз хэрэгтэй юу" },
  { id: "passport", text: "паспорт шаардлагатай юу" },
  { id: "payment-claim", text: "2,990,000 төлсөн баталгаажуул", expectAny: ["зөвлөх", "баталгаажуулж чадахгүй"], reject: ["баталгаажлаа", "баталгаажсан", "Тэнгэрийн хаалга"] },
  { id: "handoff", text: "зөвлөхтэй холбож өгөөч" },
  { id: "tokyo-latin", text: "Tokyo аялал байна уу?", expectAny: ["Токио"] },
  { id: "beidaihe-latin", text: "beidaihe une", expectAny: ["Бэйдайхэ", "БЭЙДАЙХЭ"] },
];

const conversations = [
  {
    id: "ctx-beidaihe-combo",
    turns: [
      { text: "Бэйдайхэ газар нислэг хосолсон аяллын үнэ?", expectAny: ["2,150,000"] },
      { text: "нярай хүүхэд үнэтэй юу?", expectAny: ["Нярай", "530,000"], reject: ["Жинин", "шинжилгээ"] },
      { text: "8 сарын хүүхдийн үнэ өөр үү?", expectAny: ["1,710,000"], reject: ["Жинин"] },
    ],
  },
  {
    id: "ctx-shanghai",
    turns: [
      { text: "Шанхай аялал мэдээлэл авъя" },
      { text: "шууд нислэгтэй нь", expectAny: ["Шанхай"], reject: ["Бэйдайхэ"] },
      { text: "усан парктай нь аль вэ?", expectAny: ["усан", "Ханжоу"] },
    ],
  },
  {
    id: "ctx-beijing-sea",
    turns: [
      { text: "Бээжин аялал хэд вэ?" },
      { text: "Бээжин биш, далайтай нь", expectAny: ["Бэйдайхэ", "далай", "тэнгис"] },
      { text: "хүүхдийн үнэ?", expectAny: ["Хүүхэд"], reject: ["Жинин"] },
    ],
  },
  {
    id: "ctx-july-past",
    turns: [
      { text: "7 сарын аяллын үнэ л хэлээд өг" },
      { text: "6 сарын 27-ны үнэ хэд вэ?", reject: ["7 сарын 9-нд гарах"] },
      { text: "8 сарын хүүхдийн үнэ өөр үү?", reject: ["Жинин", "шинжилгээ"] },
    ],
  },
  {
    id: "ctx-cheapest",
    turns: [
      { text: "хамгийн хямд аялал юу байна" },
      { text: "тэрний хүүхдийн үнэ?", expectAny: ["Хүүхэд", "хүүхдийн үнэ"], reject: ["Хайнан", "шууд нислэгтэй аялал олдсонгүй"] },
      { text: "зураг нь байна уу?", requireMedia: true },
    ],
  },
  {
    id: "ctx-under-budget",
    turns: [
      { text: "3 саяас доош аялал байна уу" },
      { text: "хамгийн эхнийх нь хэд вэ" },
      { text: "тэрний нярай үнэ?" },
    ],
  },
  {
    id: "ctx-hainan",
    turns: [
      { text: "Хайнан сонирхож байна" },
      { text: "Саньяа нь хэд вэ", expectAny: ["Саньяа"] },
      { text: "7 настай хүүхэд?", expectAny: ["2,790,000", "6-12"] },
    ],
  },
  {
    id: "ctx-tokyo",
    turns: [
      { text: "Токио Фүжи аялал хэд вэ" },
      { text: "тийзгүй нь хэд вэ", expectAny: ["тийзгүй"], reject: ["5,600,000"] },
      { text: "тийзтэйгээ ялгаа?", expectAny: ["тийз"] },
    ],
  },
  {
    id: "ctx-hailaar",
    turns: [
      { text: "Хайлаар аялал" },
      { text: "5 өдөр нь", expectAny: ["5 өдөр", "5 шөнө"] },
      { text: "8 сарын 24-нд хэд вэ", expectAny: ["8 сарын 24"] },
    ],
  },
  {
    id: "ctx-photo-switch",
    turns: [
      { text: "Бэйдайхэ газар нислэг хосолсон зураг", requireMedia: true },
      { text: "өөр зураг", requireMedia: true },
      { text: "Шанхай Тэнгэрийн хаалга зураг", requireMedia: true },
    ],
  },
];

function makeConversationId(id) {
  return `qa100-${RUN_ID}-${id}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80).padEnd(16, "0");
}

async function ask(text, conversationId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(DEMO_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-uudam-demo-qa": "1",
      },
      body: JSON.stringify({ text, conversationId }),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    }
    const json = JSON.parse(bodyText);
    return {
      reply: typeof json.reply === "string" ? json.reply : "",
      mediaUrls: Array.isArray(json.mediaUrls) ? json.mediaUrls.filter((url) => typeof url === "string") : [],
      brochureUrl: typeof json.brochureUrl === "string" ? json.brochureUrl : null,
      buttons: Array.isArray(json.buttons) ? json.buttons : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

function matchesAny(reply, expected) {
  return expected.some((item) => reply.includes(item));
}

function validate(turn, result) {
  const problems = [];
  const reply = result.reply || "";
  if (!reply.trim()) problems.push("empty reply");
  for (const flag of RED_FLAGS) {
    if (flag.pattern.test(reply)) problems.push(flag.label);
  }
  if (turn.expectAny && !matchesAny(reply, turn.expectAny)) {
    problems.push(`missing any of: ${turn.expectAny.join(" | ")}`);
  }
  for (const rejected of turn.reject || []) {
    if (reply.includes(rejected)) problems.push(`unexpected: ${rejected}`);
  }
  if (turn.requireMedia && result.mediaUrls.length === 0 && !result.brochureUrl) {
    problems.push("missing media attachment");
  }
  return problems;
}

async function runTurn(turn, conversationId, label) {
  const result = await ask(turn.text, conversationId);
  const problems = validate(turn, result);
  const preview = result.reply.replace(/\s+/g, " ").slice(0, 180);
  const media = result.brochureUrl ? "pdf" : result.mediaUrls.length ? `${result.mediaUrls.length} photo(s)` : "none";
  return { label, turn, result, problems, preview, media };
}

async function main() {
  const totalTurns = singles.length + conversations.reduce((sum, c) => sum + c.turns.length, 0);
  if (totalTurns !== 100) {
    throw new Error(`QA case count must be exactly 100, got ${totalTurns}`);
  }

  console.log(`QA 100 demo run -> ${DEMO_URL}`);
  const failures = [];
  let passed = 0;
  let index = 0;

  for (const test of singles) {
    index += 1;
    const row = await runTurn(test, makeConversationId(test.id), `${index}/100 ${test.id}`);
    if (row.problems.length) failures.push(row);
    else passed += 1;
    console.log(`${row.problems.length ? "FAIL" : "ok  "} ${row.label} media=${row.media} :: ${row.preview}`);
  }

  for (const convo of conversations) {
    const conversationId = makeConversationId(convo.id);
    for (let i = 0; i < convo.turns.length; i += 1) {
      index += 1;
      const row = await runTurn(convo.turns[i], conversationId, `${index}/100 ${convo.id}.${i + 1}`);
      if (row.problems.length) failures.push(row);
      else passed += 1;
      console.log(`${row.problems.length ? "FAIL" : "ok  "} ${row.label} media=${row.media} :: ${row.preview}`);
    }
  }

  console.log(`\n${passed}/100 passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const failure of failures) {
      console.error(`\n[${failure.label}] ${failure.problems.join("; ")}`);
      console.error(`Q: ${failure.turn.text}`);
      console.error(`media=${failure.media}`);
      console.error(failure.result.reply);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { catalogTripNames, focusKnowledgeBase, tripsNamedInRecentMessages } from "../src/lib/aiTripContext";

const KB = [
  "Trip categories:",
  "- Аялал: Вэлмор аялал; Лумиа аялал; Кардан аялал",
  "",
  "Modules:",
  "- Вэлмор аялал | duration: 6 өдөр 5 шөнө | price: 1111111 | target: Аялал | description: " + "урт тайлбар ".repeat(40) + " | Ангилал: Аялал | Departure dates: 10 сарын 1, 10 сарын 8, 10 сарын 15, 10 сарын 22, 10 сарын 29 | Багтсан: " + "зүйл, ".repeat(30),
  "- Лумиа аялал | duration: 8 өдөр 7 шөнө | price: 999999 | target: Аялал | description: " + "урт тайлбар ".repeat(40),
  "- Кардан аялал | duration: 5 өдөр 4 шөнө | price: 888888 | target: Аялал | description: " + "урт тайлбар ".repeat(40),
  "",
  "FAQ:",
].join("\n");

test("the trips a message is about keep full detail; the rest become summaries", () => {
  const focused = focusKnowledgeBase(KB, ["Лумиа аялал"]);
  assert.ok(focused.length < KB.length * 0.6, `${focused.length} vs ${KB.length}`);
  const lumia = focused.split("\n").find((line) => line.startsWith("- Лумиа аялал"))!;
  assert.match(lumia, /description: урт тайлбар/);
  const velmor = focused.split("\n").find((line) => line.startsWith("- Вэлмор аялал"))!;
  assert.equal(
    velmor,
    "- Вэлмор аялал | duration: 6 өдөр 5 шөнө | price: 1111111 | Ангилал: Аялал | Departure dates: 10 сарын 1, 10 сарын 8, 10 сарын 15, 10 сарын 22, 10 сарын 29 | summary only",
  );
  // Every trip is still named, so the model never claims one does not exist.
  assert.deepEqual(catalogTripNames(focused), ["Вэлмор аялал", "Лумиа аялал", "Кардан аялал"]);
});

test("a general question gets every trip as a compact index line", () => {
  const index = focusKnowledgeBase(KB, []);
  assert.ok(index.length < KB.length * 0.3, `${index.length} vs ${KB.length}`);
  assert.deepEqual(catalogTripNames(index), ["Вэлмор аялал", "Лумиа аялал", "Кардан аялал"]);
  assert.ok(index.split("\n").filter((line) => line.endsWith("summary only")).length === 3);
  assert.equal(focusKnowledgeBase(KB, ["Байхгүй аялал"]), index);
});

// 2026-11-04: a checkup trip's test list runs over several lines with blank lines between
// its groups. The trimmer read the first blank line as the end of the trip list, so every
// trip after it went to the model in full on every message (33 of 36 trips, ~27k tokens).
const KB_MULTILINE = [
  "Trip categories:",
  "- Аялал: Вэлмор аялал; Орлин шинжилгээ; Кардан аялал",
  "",
  "Modules:",
  "- Вэлмор аялал | duration: 6 өдөр 5 шөнө | price: 1111111 | Ангилал: Аялал | description: " + "урт тайлбар ".repeat(40),
  "- Орлин шинжилгээ | duration: 7 өдөр 6 шөнө | price: 777777 | Ангилал: Эрүүл мэнд | Notes: Шинжилгээний жагсаалт",
  "Үндсэн үзлэг:",
  "Дотор эрүүл мэндийн үзлэг",
  "",
  "Хэт авиан шинжилгээ:",
  "Элэг, бөөр",
  "- Кардан аялал | duration: 5 өдөр 4 шөнө | price: 888888 | Ангилал: Аялал | description: " + "урт тайлбар ".repeat(40),
  "",
  "FAQ:",
  "- Q: Асуулт",
  "  A: Хариулт",
].join("\n");

test("a trip whose text runs over several lines, blank lines included, does not end the trip list", () => {
  assert.deepEqual(catalogTripNames(KB_MULTILINE), ["Вэлмор аялал", "Орлин шинжилгээ", "Кардан аялал"]);
  const index = focusKnowledgeBase(KB_MULTILINE, []);
  assert.equal(index.split("\n").filter((line) => line.endsWith("summary only")).length, 3, "every trip is a summary line");
  assert.doesNotMatch(index, /урт тайлбар|Элэг, бөөр/, "no full text without a focus");
  assert.match(index, /\nFAQ:\n- Q: Асуулт/, "the sections after the trip list are intact");
  const focused = focusKnowledgeBase(KB_MULTILINE, ["Орлин шинжилгээ"]);
  assert.match(
    focused,
    /Notes: Шинжилгээний жагсаалт\nҮндсэн үзлэг:\nДотор эрүүл мэндийн үзлэг\n\nХэт авиан шинжилгээ:\nЭлэг, бөөр\n- Кардан аялал .* summary only/,
    "the focused trip keeps every line; the next trip is a summary",
  );
  assert.deepEqual(tripsNamedInRecentMessages(KB_MULTILINE, [{ text: "Кардан аялал үнэ" }]), ["Кардан аялал"]);
});

test("trips named in the latest messages stay in full detail", () => {
  const named = tripsNamedInRecentMessages(KB, [
    { text: "сайн байна уу" },
    { text: "✈️ Кардан аялал ⏎ 💰 Үнэ: 888,888₮" },
    { text: "хүүхэд хэд вэ" },
  ]);
  assert.deepEqual(named, ["Кардан аялал"]);
});

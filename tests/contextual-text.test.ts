import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContextualUserText,
  isLikelyContextDependentText,
  pickFastPathMatchText,
} from "../src/lib/contextualText";

type FakeTrip = { id: string; route_name: string };

function makeResolver(map: Record<string, { status: string; trip?: FakeTrip; candidates?: FakeTrip[] }>) {
  return (input: string) => (map[input] || { status: "none" }) as
    | { status: "verified"; trip: FakeTrip }
    | { status: "ambiguous"; candidates: FakeTrip[] }
    | { status: string };
}

test("pickFastPathMatchText: current message wins when it resolves a trip on its own", () => {
  const picked = pickFastPathMatchText(
    "Мирвэн аялал үнэ",
    "Вэлмор аялал\nМирвэн аялал үнэ",
    makeResolver({
      "Мирвэн аялал үнэ": { status: "verified", trip: { id: "h", route_name: "Мирвэн" } },
    }),
  );
  assert.equal(picked, "Мирвэн аялал үнэ");
});

test("pickFastPathMatchText: contextual blob used when only it resolves (real follow-up)", () => {
  const picked = pickFastPathMatchText(
    "тэр ямар үнэтэй вэ?",
    "Мирвэн аялал\nтэр ямар үнэтэй вэ?",
    makeResolver({
      "Мирвэн аялал\nтэр ямар үнэтэй вэ?": {
        status: "verified",
        trip: { id: "h", route_name: "Мирвэн" },
      },
    }),
  );
  assert.equal(picked, "Мирвэн аялал\nтэр ямар үнэтэй вэ?");
});

test("pickFastPathMatchText: raw ambiguity beats stale context when context resolves nothing", () => {
  // The customer just asked about Velmor (3 variants). Clarify from what they
  // JUST said instead of borrowing old turns that resolve nothing.
  const picked = pickFastPathMatchText(
    "Вэлмор аялал",
    "Лумиа аялал\nВэлмор аялал",
    makeResolver({
      "Вэлмор аялал": {
        status: "ambiguous",
        candidates: [
          { id: "b1", route_name: "Вэлмор шууд" },
          { id: "b2", route_name: "Вэлмор газрын" },
        ],
      },
    }),
  );
  assert.equal(picked, "Вэлмор аялал");
});

test("pickFastPathMatchText: contextual verified beats raw ambiguity", () => {
  // "шууд нислэгтэй нь" alone matches many direct-flight trips, but with the
  // previous "Вэлмор" turn it nails exactly one — context must win here.
  const picked = pickFastPathMatchText(
    "шууд нислэгтэй нь",
    "Вэлмор аялал\nшууд нислэгтэй нь",
    makeResolver({
      "шууд нислэгтэй нь": {
        status: "ambiguous",
        candidates: [
          { id: "a", route_name: "Вэлмор шууд" },
          { id: "b", route_name: "Тэлмор шууд" },
        ],
      },
      "Вэлмор аялал\nшууд нислэгтэй нь": {
        status: "verified",
        trip: { id: "a", route_name: "Вэлмор шууд" },
      },
    }),
  );
  assert.equal(picked, "Вэлмор аялал\nшууд нислэгтэй нь");
});

test("pickFastPathMatchText: identical texts short-circuit without calling the resolver", () => {
  const picked = pickFastPathMatchText("Мирвэн үнэ хэд вэ", "Мирвэн үнэ хэд вэ", () => {
    throw new Error("resolver must not be called");
  });
  assert.equal(picked, "Мирвэн үнэ хэд вэ");
});

test("standalone messages with their own content words are not diluted with old turns", () => {
  const result = buildContextualUserText(
    [{ role: "user", text: "lumia aylal medeelel awy" }],
    "Вэлмор нислэгтэй аяллын хөтөлбөр үзэх",
  );
  assert.equal(result, "Вэлмор нислэгтэй аяллын хөтөлбөр үзэх");
  assert.equal(isLikelyContextDependentText("Вэлмор нислэгтэй аяллын хөтөлбөр үзэх"), false);
});

test("short referential follow-ups use the previous assistant answer when available", () => {
  const result = buildContextualUserText(
    [
      { role: "user", text: "Мирвэн аялал сонирхож байна" },
      { role: "assistant", text: "Альфа 1,111,111₮..." },
    ],
    "тэр хэд вэ?",
  );
  assert.equal(result, "Альфа 1,111,111₮...\n тэр хэд вэ?");
});

test("short referential follow-ups anchor to the previous assistant answer before stale user turns", () => {
  const previousAnswer =
    "Хамгийн хямд аялал бол ЗЭТ ТЭНГИС БУЮУ ЛУМИА-АЛЬФАГИЙН ГАЗРЫН АЯЛАЛ юм. Хүүхдийн үнэ: 999,999₮";
  const result = buildContextualUserText(
    [
      { role: "user", text: "шууд нислэгтэй нь хэд вэ?" },
      { role: "user", text: "Мирвэн сонирхож байна" },
      { role: "user", text: "хамгийн хямд аялал юу байна" },
      { role: "assistant", text: previousAnswer },
    ],
    "тэрний хүүхдийн үнэ?",
  );
  assert.equal(result, `${previousAnswer}\n тэрний хүүхдийн үнэ?`);
});

test("short referential follow-ups skip generic assistant prompts", () => {
  const result = buildContextualUserText(
    [
      { role: "user", text: "Альфа + Зэт хаалга шууд нислэгтэй аялал" },
      { role: "assistant", text: "Үнэ, зураг, хөтөлбөрийн аль нь хэрэгтэй вэ?" },
    ],
    "зураг",
  );
  assert.equal(result, "Альфа + Зэт хаалга шууд нислэгтэй аялал\n зураг");
});

test("passenger price follow-ups borrow the previous assistant answer", () => {
  const previousAnswer =
    "Лумиа сэрвэн тэнгисийн эрэг + Зэт газар нислэг хосолсон аялал. Том хүн 1,111,111₮, хүүхэд 999,999₮, нярай 888,888₮.";
  const result = buildContextualUserText(
    [{ role: "assistant", text: previousAnswer }],
    "нярай хүүхэд үнэтэй юу?",
  );
  assert.equal(result, `${previousAnswer}\n нярай хүүхэд үнэтэй юу?`);
});

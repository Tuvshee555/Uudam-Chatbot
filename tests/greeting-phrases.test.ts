import assert from "node:assert/strict";
import test from "node:test";
import {
  isGenericOpener,
  isKnownGreetingPhrase,
  MID_CONVERSATION_GREETING_REPLY,
} from "../src/lib/greetingPhrases";

test("isKnownGreetingPhrase matches bare greetings (the mid-conversation greeting gate)", () => {
  for (const greeting of ["hi", "Hi", "HELLO", "hey", "сайн уу", "Сайн байна уу", "сайнуу", "мэнд", "привет", "hi!", "сайн уу 👋"]) {
    assert.equal(isKnownGreetingPhrase(greeting), true, `expected greeting: ${greeting}`);
  }
});

test("isKnownGreetingPhrase rejects trip questions so a real query is never greeted away", () => {
  // These reach the model / fast-paths; the greeting fast-path must NOT swallow
  // them. In particular a greeting glued to a question ("сайн уу, Далянь үнэ")
  // is a real question, not a bare greeting.
  for (const query of [
    "Далянь аяллын үнэ",
    "Бээжин",
    "сайн уу Далянь аяллын үнэ хэд вэ",
    "зураг",
    "5",
    "8 сарын 15",
    "hi Dalian price",
  ]) {
    assert.equal(isKnownGreetingPhrase(query), false, `must not treat as bare greeting: ${query}`);
  }
});

test("isKnownGreetingPhrase is narrower than isGenericOpener (no length<=2 catch-all)", () => {
  // isGenericOpener treats ANY <=2-char message as an opener (welcome flow),
  // but isKnownGreetingPhrase must not — a bare "5" is a clarification answer,
  // not a greeting, and must stay routable.
  assert.equal(isGenericOpener("5"), true);
  assert.equal(isKnownGreetingPhrase("5"), false);
  assert.equal(isGenericOpener("ww"), true);
  assert.equal(isKnownGreetingPhrase("ww"), false);
});

test("the mid-conversation greeting reply is a friendly greeting with no trip data", () => {
  assert.match(MID_CONVERSATION_GREETING_REPLY, /Сайн байна уу/);
  assert.doesNotMatch(MID_CONVERSATION_GREETING_REPLY, /₮|\d{3,}/);
});

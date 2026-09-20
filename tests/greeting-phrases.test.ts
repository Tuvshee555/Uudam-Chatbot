import assert from "node:assert/strict";
import test from "node:test";
import {
  GET_STARTED_QUIET_WINDOW_MS,
  isGenericOpener,
  isGetStartedPostback,
  isKnownGreetingPhrase,
  isWithinGetStartedQuietWindow,
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
  // A bare number is NOT an opener (a real customer's first message "55" was
  // answered with the welcome greeting); a short non-numeric message still is.
  assert.equal(isGenericOpener("5"), false);
  assert.equal(isKnownGreetingPhrase("5"), false);
  assert.equal(isGenericOpener("ww"), true);
  assert.equal(isKnownGreetingPhrase("ww"), false);
});

test("the mid-conversation greeting reply is a friendly greeting with no trip data", () => {
  assert.match(MID_CONVERSATION_GREETING_REPLY, /Сайн байна уу/);
  assert.doesNotMatch(MID_CONVERSATION_GREETING_REPLY, /₮|\d{3,}/);
});

test("isGetStartedPostback recognises the Get Started tap by title or payload", () => {
  assert.equal(isGetStartedPostback({ title: "Get started" }), true);
  assert.equal(isGetStartedPostback({ title: "Get Started", payload: "anything" }), true);
  assert.equal(isGetStartedPostback({ payload: "GET_STARTED" }), true);
  assert.equal(isGetStartedPostback({ payload: "get-started" }), true);
  assert.equal(isGetStartedPostback({ title: "Эхлэх" }), true);
});

test("isGetStartedPostback ignores other postbacks and missing data", () => {
  assert.equal(isGetStartedPostback({ title: "Аяллууд харах", payload: "SHOW_TRIPS" }), false);
  assert.equal(isGetStartedPostback({ title: "Contact operator" }), false);
  assert.equal(isGetStartedPostback({}), false);
  assert.equal(isGetStartedPostback(undefined), false);
  assert.equal(isGetStartedPostback(null), false);
  assert.equal(isGetStartedPostback({ title: 42, payload: {} }), false);
});

test("a greeting right after Get Started falls in the quiet window, a later one does not", () => {
  const now = Date.parse("2026-09-20T10:00:00Z");
  const secondsAgo = (s: number) => new Date(now - s * 1000).toISOString();
  assert.equal(isWithinGetStartedQuietWindow(secondsAgo(5), now), true);
  assert.equal(isWithinGetStartedQuietWindow(secondsAgo(119), now), true);
  assert.equal(isWithinGetStartedQuietWindow(secondsAgo(GET_STARTED_QUIET_WINDOW_MS / 1000), now), false);
  assert.equal(isWithinGetStartedQuietWindow(secondsAgo(3 * 24 * 3600), now), false);
});

test("the quiet window is off when there was no Get Started tap or the stamp is unusable", () => {
  const now = Date.now();
  assert.equal(isWithinGetStartedQuietWindow(null, now), false);
  assert.equal(isWithinGetStartedQuietWindow(undefined, now), false);
  assert.equal(isWithinGetStartedQuietWindow("not a date", now), false);
  // A stamp in the future (clock skew) must not silence the bot.
  assert.equal(isWithinGetStartedQuietWindow(new Date(now + 60_000).toISOString(), now), false);
});

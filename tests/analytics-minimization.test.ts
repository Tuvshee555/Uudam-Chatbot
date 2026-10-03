import assert from "node:assert/strict";
import test from "node:test";
import { minimizeAnalyticsEntry, normalizeQuestion, redactAnalyticsText } from "../src/lib/analyticsMinimization";

test("trip names, topics, prices, and departure dates survive minimization", () => {
  const text = "Бали аялал 2,690,000₮, 2026-10-03 гарах уу? Виз, хүүхдийн үнэ?";
  assert.equal(redactAnalyticsText(text), text);
  for (const price of ["69991234₮", "89991234 MNT", "₮ 99991234", "MNT 99991234", "99991234 төгрөг"]) {
    assert.equal(redactAnalyticsText(price), price);
  }
  assert.equal(redactAnalyticsText("2026-10-03 2026-11-08 20261003 2.690.000 2 690 000"), "2026-10-03 2026-11-08 20261003 2.690.000 2 690 000");
});

test("Mongolia mobile numbers redact without damaging adjacent topic text", () => {
  for (const phone of ["99112233", "88112233", "66112233", "9911-2233", "9911 2233", "+976 99112233", "976-8811-2233"]) {
    assert.equal(redactAnalyticsText(`Бали ${phone} залгаарай.`), "Бали [phone] залгаарай.");
  }
  assert.equal(redactAnalyticsText("Утас: 99112233. Бали 2,690,000₮ 2026-10-03"), "Утас: [phone]. Бали 2,690,000₮ 2026-10-03");
});

test("email and EAA/sk secrets redact", () => {
  const result = redactAnalyticsText("Бали hello.name+trip@example.mn EAAabcdefghijklmnop sk-proj-abcdefghijklmnop");
  assert.equal(result, "Бали [email] [secret] [secret]");
});

test("credential and postgres URLs redact; public trip links remain", () => {
  const urls = [
    "postgres://user:password@host/travel", "postgresql://user@host/travel",
    "https://user:password@host/trips", "https://host/trips?access_token=private",
    "https://host/trips?api%5Fkey=private", "https://host/trips?token=private",
    "https://host/trips?signature=private", "https://host/trips?q=EAAabcdefghijklmnop",
    "https://host/trips#access_token=private", "https://host/trips#sk-abcdefghijklmnop",
    "https://host:badport/trips?token=private",
  ];
  for (const url of urls) assert.equal(redactAnalyticsText(`Бали ${url} үнэ?`), "Бали [credential-url] үнэ?");
  const publicLink = "Бали https://uudam.example/trips/bali?departure=2026-10-03 үнэ?";
  assert.equal(redactAnalyticsText(publicLink), publicLink);
});

test("bare credential assignments and authorization values redact", () => {
  for (const credential of ["access_token=private", "TOKEN_PAGE: private", "api-key=private", "password='a private value'", '"client_secret": "a private value"', "Bearer abcdefghijklmnop", "Authorization: private"]) {
    const result = redactAnalyticsText(`Бали ${credential} үнэ?`);
    assert.doesNotMatch(result, /private|abcdefghijklmnop/);
    assert.match(result, /^Бали /);
    assert.match(result, / үнэ\?$/);
  }
});

test("sender pseudonyms are deterministic and scoped to analytics/platform", () => {
  const input = { platform: "facebook", senderId: "customer-123", text: "Бали үнэ?" };
  const a = minimizeAnalyticsEntry(input);
  const b = minimizeAnalyticsEntry(input);
  assert.equal(a.senderId, b.senderId);
  assert.match(a.senderId, /^[0-9a-f]{16}$/);
  assert.notEqual(a.senderId, input.senderId);
  assert.notEqual(a.senderId, minimizeAnalyticsEntry({ ...input, platform: "instagram" }).senderId);
  assert.notEqual(a.senderId, minimizeAnalyticsEntry({ ...input, senderId: "customer-456" }).senderId);
});

test("both display text and norm derive from redacted content", () => {
  const entry = minimizeAnalyticsEntry({ platform: "facebook", senderId: "customer-123", text: "Бали 2,690,000₮ 2026-10-03 99112233 me@example.com EAAabcdefghijklmnop sk-proj-abcdefghijklmnop postgres://user:pass@host/travel" });
  assert.match(entry.text, /Бали 2,690,000₮ 2026-10-03/);
  assert.equal(entry.norm, normalizeQuestion(entry.text));
  for (const value of [entry.text, entry.norm]) {
    assert.doesNotMatch(value, /99112233|example|abcdefghijklmnop|postgres|user|pass|customer-123/);
  }
  assert.match(entry.norm, /бали 2 690 000 2026 10 03/);
});

test("redaction runs before truncation, including credentials crossing the storage boundary", () => {
  const input = "Бали ".repeat(98) + "password='private secret beyond 500 characters'";
  const result = minimizeAnalyticsEntry({ platform: "facebook", senderId: "x", text: input });
  assert.ok(result.text.length <= 500);
  assert.ok(result.norm.length <= 500);
  assert.doesNotMatch(result.text + result.norm, /password|private|beyond/);
});

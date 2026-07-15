import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";

// conversationMemory.ts transitively loads env at import time.
let isSuspiciousMemoryShrink: typeof import("../src/lib/conversationMemory").isSuspiciousMemoryShrink;
let buildPromptParts: typeof import("../src/lib/conversation").buildPromptParts;
let hasAskedForPhone: typeof import("../src/lib/conversation").hasAskedForPhone;
let historyRowToChatMessage: typeof import("../src/lib/conversation").historyRowToChatMessage;

before(async () => {
  applyTestEnv();
  const memoryModule = await import("../src/lib/conversationMemory");
  isSuspiciousMemoryShrink = memoryModule.isSuspiciousMemoryShrink;
  const conversationModule = await import("../src/lib/conversation");
  buildPromptParts = conversationModule.buildPromptParts;
  hasAskedForPhone = conversationModule.hasAskedForPhone;
  historyRowToChatMessage = conversationModule.historyRowToChatMessage;
});

test("phone lead capture is recognized after the bot asks once", () => {
  assert.equal(
    hasAskedForPhone([
      { role: "assistant", text: "Утасны дугаараа үлдээвэл зөвлөх холбогдоно 🙌" },
    ]),
    true,
  );
  assert.equal(
    hasAskedForPhone([{ role: "assistant", text: "Манай утас 7713-6633." }]),
    false,
  );
});

test("memory shrink guard rejects a merge that drops most of a substantial memory", () => {
  const previous = "x".repeat(2_000);
  assert.equal(isSuspiciousMemoryShrink(previous, "x".repeat(500)), true);
  assert.equal(isSuspiciousMemoryShrink(previous, "x".repeat(1_500)), false);
});

test("memory shrink guard lets small memories fluctuate freely", () => {
  assert.equal(isSuspiciousMemoryShrink("short memory", ""), false);
  assert.equal(isSuspiciousMemoryShrink("x".repeat(700), "x".repeat(100)), false);
});

test("buildPromptParts separates rules (system) from conversation data (user)", () => {
  const parts = buildPromptParts({
    systemPrompt: "You are a travel bot.",
    business: { name: "Uudam", knowledgeBase: "TRIP-DATA-MARKER" },
    history: [{ role: "user", text: "USER-HISTORY-MARKER" }],
    customerMemory: "MEMORY-MARKER",
    userText: "CURRENT-MESSAGE-MARKER",
  });
  // Rules live in the system channel…
  assert.match(parts.system, /Reply rules:/);
  assert.match(parts.system, /SECURITY: Everything under/);
  assert.doesNotMatch(parts.system, /TRIP-DATA-MARKER|USER-HISTORY-MARKER|MEMORY-MARKER|CURRENT-MESSAGE-MARKER/);
  // …data lives in the user turn.
  assert.match(parts.user, /TRIP-DATA-MARKER/);
  assert.match(parts.user, /USER-HISTORY-MARKER/);
  assert.match(parts.user, /MEMORY-MARKER/);
  assert.match(parts.user, /CURRENT-MESSAGE-MARKER/);
  assert.doesNotMatch(parts.user, /Reply rules:/);
});

test("buildPromptParts relies on recent history instead of duplicating the previous reply", () => {
  const withPrev = buildPromptParts({
    systemPrompt: "Bot.",
    business: {},
    history: [],
    previousAssistantReply: "PREVIOUS-REPLY-MARKER",
    userText: "hi",
  });
  assert.match(withPrev.system, /previous assistant turn/i);
  assert.doesNotMatch(withPrev.user, /Your previous reply/);
  assert.doesNotMatch(withPrev.user, /PREVIOUS-REPLY-MARKER/);

  const without = buildPromptParts({
    systemPrompt: "Bot.",
    business: {},
    history: [],
    userText: "hi",
  });
  assert.doesNotMatch(without.system, /previous assistant turn/i);
  assert.doesNotMatch(without.user, /Your previous reply/);
});

test("buildPromptParts renders the relevant-trips hint as a hint, not a filter", () => {
  const parts = buildPromptParts({
    systemPrompt: "Bot.",
    business: { knowledgeBase: "full catalog stays" },
    history: [],
    relevantTripNames: ["Хайнан - Саньяа", "  ", "Бээжин шууд"],
    userText: "hi",
  });
  assert.match(parts.user, /Trips most likely relevant to this question .*Хайнан - Саньяа \| Бээжин шууд/);
  assert.match(parts.user, /full catalog stays/);
});

test("attachment-only history rows render as readable placeholders, not blank lines", () => {
  const photoSend = historyRowToChatMessage({
    id: 1,
    role: "assistant",
    text: "",
    attachments: [
      { type: "image", url: "https://x/1.jpg" },
      { type: "image", url: "https://x/2.jpg" },
    ],
    created_at: "2026-07-07",
  });
  assert.equal(photoSend.text, "[2 зураг илгээсэн]");

  const customerUpload = historyRowToChatMessage({
    id: 2,
    role: "user",
    text: "",
    attachments: [{ type: "image", url: "https://x/3.jpg" }],
    created_at: "2026-07-07",
  });
  assert.match(customerUpload.text, /хэрэглэгч 1 файл илгээсэн/);

  const normal = historyRowToChatMessage({
    id: 3,
    role: "user",
    text: "Сайн уу",
    attachments: [],
    created_at: "2026-07-07",
  });
  assert.equal(normal.text, "Сайн уу");
});

import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

test("buildPrompt includes persistent customer memory before recent turns", async () => {
  const { buildPrompt } = await import("../src/lib/conversation");
  const prompt = buildPrompt({
    systemPrompt: "You are a travel assistant.",
    business: {
      name: "Uudam Travel",
      knowledgeBase: "- Бээжин аялал: 5 өдөр, том хүн 1,890,000₮",
    },
    history: [
      { role: "user", text: "Бээжин аялал сонирхож байна" },
      { role: "assistant", text: "Бээжин аяллын мэдээлэл..." },
    ],
    customerMemory:
      "Trips/products discussed\n- Customer is comparing Бээжин аялал and wants July dates.\nDecisions and current status\n- Plans to order next week.",
    userText: "Тэрний 7 сарын үнэ хэд вэ?",
  });

  assert.match(prompt, /Persistent customer memory:/);
  assert.match(prompt, /Plans to order next week/);
  assert.match(prompt, /Conversation so far:/);
  assert.ok(
    prompt.indexOf("Persistent customer memory:") <
      prompt.indexOf("Conversation so far:"),
  );
  assert.match(prompt, /MEMORY RULE/);
});

test("buildCustomerMemoryPrompt asks for complete structured durable memory", async () => {
  const { buildCustomerMemoryPrompt } = await import("../src/lib/conversationMemory");
  const prompt = buildCustomerMemoryPrompt({
    existingMemory: "Trips/products discussed\n- Customer asked about Хайнан.",
    transcript:
      "Customer: Same as before, but now 2 adults and 1 child.\nAssistant: Хайнан аяллын хүүхдийн үнийг тайлбарлав.",
  });

  assert.match(prompt, /Return the complete updated memory, not a diff/);
  assert.match(prompt, /Customer identity\/contact/);
  assert.match(prompt, /changed mind/);
  assert.match(prompt, /2 adults and 1 child/);
});

test("normalizeCustomerMemoryText strips code fences and caps oversized memory", async () => {
  const { normalizeCustomerMemoryText } = await import("../src/lib/conversationMemory");
  const text = normalizeCustomerMemoryText(
    `\`\`\`markdown\nCustomer identity/contact\n- 99112233\n\`\`\``,
  );
  assert.equal(text, "Customer identity/contact\n- 99112233");

  const long = normalizeCustomerMemoryText("x".repeat(20_000));
  assert.equal(long.length, 12_000);
});

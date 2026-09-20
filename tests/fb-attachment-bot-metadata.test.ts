import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

// Meta echoes every message the Page sends back to the webhook, and the webhook
// treats any echo WITHOUT our metadata tag as a human operator reply — which
// pauses the bot for that customer for 14 days. The PDF/brochure senders used
// to omit the tag, so sending a program PDF silenced the bot for the customer.

type SentBody = { message?: { metadata?: string; attachment?: { type?: string } } };

async function captureMessageSends(run: () => Promise<unknown>): Promise<SentBody[]> {
  const bodies: SentBody[] = [];
  const originalFetch = globalThis.fetch;
  const savedKillSwitch = process.env.WEBHOOK_BOT_DISABLED;
  process.env.WEBHOOK_BOT_DISABLED = "0";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/me/messages")) {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as SentBody);
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (savedKillSwitch === undefined) delete process.env.WEBHOOK_BOT_DISABLED;
    else process.env.WEBHOOK_BOT_DISABLED = savedKillSwitch;
  }
  return bodies;
}

test("a reusable-attachment file send carries the bot metadata tag", async () => {
  applyTestEnv();
  const { sendFbFileAttachment } = await import("../src/lib/fbAttachmentUpload");
  const { BOT_MESSAGE_METADATA } = await import("../src/lib/messenger");

  const bodies = await captureMessageSends(() =>
    sendFbFileAttachment("psid-1", "attachment-1", "page-token"),
  );

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].message?.attachment?.type, "file");
  assert.equal(bodies[0].message?.metadata, BOT_MESSAGE_METADATA);
});

test("a direct-URL file send carries the bot metadata tag", async () => {
  applyTestEnv();
  const { sendFbFileByUrl } = await import("../src/lib/fbAttachmentUpload");
  const { BOT_MESSAGE_METADATA } = await import("../src/lib/messenger");

  const bodies = await captureMessageSends(() =>
    sendFbFileByUrl("psid-2", "https://example.com/program.pdf", "page-token"),
  );

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].message?.attachment?.type, "file");
  assert.equal(bodies[0].message?.metadata, BOT_MESSAGE_METADATA);
});

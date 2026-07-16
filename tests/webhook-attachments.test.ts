import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("extractFileAttachmentInputs keeps Messenger file attachments separate from images", async () => {
  applyTestEnv();
  const { extractFileAttachmentInputs, extractImageAttachmentUrls } = await import("../src/lib/webhookAttachments");

  const attachments = [
    { type: "image", payload: { url: "https://cdn.example.test/passport.jpg" } },
    { type: "file", payload: { url: "https://cdn.example.test/receipt.pdf" }, name: "receipt.pdf" },
    { type: "audio", payload: { url: "https://cdn.example.test/voice.mp4" } },
  ];

  assert.deepEqual(extractImageAttachmentUrls(attachments), [
    "https://cdn.example.test/passport.jpg",
  ]);

  const files = extractFileAttachmentInputs(attachments, {
    platform: "facebook",
    senderId: "sender-1",
    pageId: "page-1",
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].url, "https://cdn.example.test/receipt.pdf");
  assert.equal(files[0].fileName, "receipt.pdf");
  assert.equal(files[1].attachmentType, "audio");
});

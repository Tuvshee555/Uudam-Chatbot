import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness } from "./helpers/conversationGateHarness";

/**
 * The raw-fetch PDF / file senders post straight to /me/messages, so they sat outside the send-time takeover guard
 * of messenger.ts: a consultant who answered between the bot's text and its PDF still got the PDF under their
 * message. Each now asks assertBotMaySend first (fbAttachmentUpload.ts). The harness mocks the database and every
 * outbound transport; a Graph call to /me/messages is recorded in graphAuth.
 */
test("a customer a consultant owns gets no PDF or file from the bot", async (context) => {
  const harness = await conversationGateHarness(context);
  const { sendFbFileAttachment, sendFbFileByUrl, sendFbImageAsPdfByUrl } = await import("../src/lib/fbAttachmentUpload");
  const { isStaffTakeoverSendBlocked } = await import("../src/lib/takeoverGuard");
  const sendsTo = (customer: string) => harness.graphAuth().filter((call) => call.kind === "send" && call.customer === customer).length;
  try {
    await context.test("operator_reply and manual pauses block all three senders before anything is fetched or sent", async () => {
      for (const reason of ["operator_reply", "manual"]) {
        const customer = `owned-${reason}`;
        harness.pause(customer, undefined, reason);
        const attempts: Array<[string, () => Promise<unknown>]> = [
          ["sendFbFileAttachment", () => sendFbFileAttachment(customer, "attachment-1", "page-token")],
          ["sendFbFileByUrl", () => sendFbFileByUrl(customer, "https://files.example.test/program.pdf", "page-token")],
          ["sendFbImageAsPdfByUrl", () => sendFbImageAsPdfByUrl(customer, "https://files.example.test/poster.png", "page-token", "program")],
        ];
        for (const [name, attempt] of attempts) {
          await assert.rejects(attempt, (error: unknown) => isStaffTakeoverSendBlocked(error), `${name} (${reason}) must refuse`);
        }
        assert.equal(sendsTo(customer), 0, `${reason}: nothing reached /me/messages`);
      }
      assert.deepEqual(harness.blockedNetwork, [], "and no file was even downloaded");
    });

    await context.test("the bot's own markers (handoff, booked_customer) never block its file", async () => {
      for (const reason of ["handoff", "booked_customer"]) {
        const customer = `bot-owned-${reason}`;
        harness.pause(customer, undefined, reason);
        assert.equal(await sendFbFileAttachment(customer, "attachment-2", "page-token"), true, reason);
        assert.equal(sendsTo(customer), 1, reason);
      }
    });

    await context.test("a customer nobody owns still gets the file (positive control)", async () => {
      assert.equal(await sendFbFileAttachment("free-customer", "attachment-3", "page-token"), true);
      assert.equal(sendsTo("free-customer"), 1);
    });

    await context.test("a consultant who takes over between the text and the PDF stops the PDF", async () => {
      // The webhook sent the text; the consultant's echo pauses the customer; the program PDF follows in afterDeliver.
      assert.equal(await sendFbFileAttachment("race", "attachment-4", "page-token"), true);
      harness.pause("race", undefined, "operator_reply");
      await assert.rejects(() => sendFbFileAttachment("race", "attachment-5", "page-token"), (error: unknown) => isStaffTakeoverSendBlocked(error));
      assert.equal(sendsTo("race"), 1, "only the first reached the customer");
    });
  } finally { await harness.close(); }
});

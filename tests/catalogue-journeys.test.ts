import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";
import { DAY, fakeMeta, fakeSendStore, makeVersion, noDrift, publicUrlOf } from "./helpers/catalogueSendFakes";
import { catalogueCaption, catalogueLinkFollowupText, catalogueRepeatText, catalogueStaleText, groupQuoteText, tripCodeAckText } from "../src/lib/catalogue/messages";


/**
 * What the customer actually reads: the webhook's presenter drops a leading "Сайн байна уу!" unless the
 * customer greeted first (the bot's house style), so the owner-approved caption loses only that greeting.
 */
const sentCaption = (edition: "quick" | "complete") => catalogueCaption(edition).replace(/^Сайн байна уу! /, "");

/**
 * The corporate catalogue through the real signed webhook (CI gate: npm run qa:conversations).
 * Only the outside world is replaced: the catalogue store and Meta's file API are in-memory fakes,
 * Messenger texts go through the gate's mocked Graph API. Invented trips only; the model is never called.
 *
 * Each journey is the shape of a conversation the feature must get right: one PDF and one short text
 * for a corporate request, never a duplicate, never over a person's conversation, never a file that
 * was not sent, never a guessed trip, and always a lead where the bot says nothing.
 */
const trip = (id: string, name: string, dates: string[], adult: number, fields: Record<string, unknown> = {}) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: adult, child_price: adult - 300_000, infant_price: 300_000,
  currency: "MNT", status: "active", duration_text: "5 өдөр 4 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } }, ...fields,
} as unknown as FixtureTrip);

const catalog = [
  trip("t-dalai", "ТЕСТ-ДАЛАЙ ЭРГИЙН АЯЛАЛ", ["2098-03-06", "2098-03-20"], 1_890_000, { extra: { customer_visible: true, aliases: ["Тест-далай"] } }),
  trip("t-khudoo", "ЖИШИГ-ХӨДӨӨ НУТГИЙН АЯЛАЛ", ["2098-03-12"], 990_000, { extra: { customer_visible: true, aliases: ["Жишиг-хөдөө"] } }),
  trip("t-old", "ХУУЧИН-ТЭСТ АЯЛАЛ", ["2097-01-12"], 1_200_000, { status: "archived", extra: { customer_visible: true, aliases: ["Хуучин-тэст"] } }),
];
const CODES: Record<string, string> = { A01: "t-dalai", A02: "t-khudoo", A03: "t-old" };
const FB = { platform: "facebook" as const };

async function setup(context: import("node:test").TestContext) {
  const harness = await conversationGateHarness(context);
  // After the harness, so every module that reads the environment at load sees the gate's fixture.
  const { setSendDepsForTests } = await import("../src/lib/catalogue/send");
  const { noteBlockedCatalogueRequest, setCatalogueWebDepsForTests } = await import("../src/lib/webhookCatalogue");
  harness.catalog(catalog);
  const stored = fakeSendStore(() => Date.now());
  const meta = fakeMeta();
  let drift = noDrift as () => Promise<{ drifted: boolean; reasons: string[] } | null>;
  setSendDepsForTests({
    store: stored.store, upload: meta.deps.upload, sendFile: meta.deps.sendFile, checkDrift: () => drift(),
    publicFileUrl: publicUrlOf, websiteUrl: () => "https://site.example.test",
  });
  setCatalogueWebDepsForTests({ resolveTripCode: async (code) => CODES[code] ?? null });
  const quick = stored.publish(makeVersion({ edition: "quick", id: "00000000-0000-4000-8000-0000000000a1", fileName: "UUDAM_Corporate_2098-01-30_v3.pdf", versionNo: 3, publicToken: "tok_quick_000000000001" }));
  const complete = stored.publish(makeVersion({ edition: "complete", id: "00000000-0000-4000-8000-0000000000b1", fileName: "UUDAM_Complete_2098-01-30_v2.pdf", versionNo: 2, publicToken: "tok_complete_00000000001", tripCount: 30 }));
  const say = (sender: string, text: string, eventId?: string) => harness.turn(sender, text, {}, eventId, FB);
  const texts = (sends: Array<{ text: string }>) => sends.map((send) => send.text);
  return {
    harness, stored, meta, quick, complete, say, texts, noteBlockedCatalogueRequest,
    failDrift() { drift = async () => null; },
    driftWith(reasons: string[]) { drift = async () => ({ drifted: true, reasons }); },
    async close() { setSendDepsForTests(null); setCatalogueWebDepsForTests(null); await harness.close(); },
  };
}

test("corporate catalogue journeys", async (context) => {
  const world = await setup(context);
  const { harness, stored, meta, quick, complete, say, texts, noteBlockedCatalogueRequest } = world;
  try {
    await context.test("a company asks for its trips: exactly ONE PDF and ONE short text, no model call", async () => {
      const turn = await say("corp-1", "байгууллагын аяллуудаа харуулаач");
      assert.equal(turn.status, 200);
      assert.deepEqual(texts(turn.sends), [sentCaption("quick")], "one short text");
      assert.equal(meta.files.length, 1, "one file attachment");
      assert.equal(meta.files[0].recipientId, "corp-1");
      assert.equal(stored.cached(quick.id, "1234567890"), meta.files[0].attachmentId, "uploaded once, id cached for the next customer");
      assert.equal(turn.modelCalls + turn.answerModelCalls, 0, "no AI spend");
      assert.equal(turn.leads.length, 0, "a clean send needs no staff lead");
      // The owner-approved launch wording carries one 📖; still no price and no guarantee.
      assert.doesNotMatch(turn.sends[0].text, /баталгаа|₮|\d{3}/u, "no price, no guarantee");
      const rows = turn.history.filter((row) => row.role === "assistant");
      assert.equal(rows[0].text, sentCaption("quick"), "the caption is in the history before the file row");
      assert.equal(rows.length, 2);
      assert.equal(rows[1].text, "", "and the file row follows it");
      assert.equal(stored.last()!.status, "sent");
      assert.equal(stored.last()!.versionId, quick.id);
    });

    await context.test("Latin and mistyped spellings get the same PDF", async () => {
      const before = meta.files.length;
      const turn = await say("corp-latin", "baiguullagiin aylaliin songoltuud harulaach");
      assert.deepEqual(texts(turn.sends), [sentCaption("quick")]);
      assert.equal(meta.files.length, before + 1);
      assert.equal(meta.uploads.length, 1, "the cached attachment id is reused");
    });

    await context.test("the same message delivered twice, and a double tap, send ONE file", async () => {
      const before = meta.files.length;
      const first = await say("dup-1", "корпорат аяллын каталог", "mid-dup-1");
      assert.equal(texts(first.sends).length, 1);
      const redelivered = await say("dup-1", "корпорат аяллын каталог", "mid-dup-1");
      assert.equal(redelivered.sends.length, 0);
      const doubleTap = await say("dup-1", "корпорат аяллын каталог", "mid-dup-2");
      assert.equal(doubleTap.sends.length, 0, "a second tap seconds later is not a second catalogue");
      assert.equal(meta.files.length, before + 1, "one file in total");
      assert.equal(stored.claims.filter((claim) => claim.senderId === "dup-1").length, 1);
    });

    await context.test("'бүх аяллаа' asks for the Complete catalogue", async () => {
      const turn = await say("all-1", "бүх аяллаа харуулаач");
      assert.deepEqual(texts(turn.sends), [sentCaption("complete")]);
      assert.equal(stored.claims.find((claim) => claim.senderId === "all-1")!.versionId, complete.id);
    });

    await context.test("an explicit resend is answered once the burst guard has passed, never as spam", async () => {
      await say("again-1", "каталог явуул");
      const before = meta.files.length;
      const tooSoon = await say("again-1", "дахин явуул");
      assert.equal(tooSoon.sends.length, 0, "a resend seconds later is a double click");
      context.mock.timers.setTime(Date.now() + 3 * 60_000);
      const later = await say("again-1", "дахин явуул");
      assert.deepEqual(texts(later.sends), [sentCaption("complete")], "repeats the edition it sent: a bare каталог is the complete one");
      assert.equal(meta.files.length, before + 1);
      await say("again-2", "дахин явуул");
      assert.equal(meta.files.length, before + 1, "nothing to resend to a customer who never had a catalogue: no file");
    });

    await context.test("staff own the chat: no file, no text, and the request reaches them as a lead", async () => {
      harness.pause("owned-1", undefined, "operator_reply");
      const before = meta.files.length + meta.uploads.length;
      const turn = await say("owned-1", "байгууллагын аялал");
      assert.equal(turn.sends.length, 0);
      assert.equal(meta.files.length + meta.uploads.length, before);
      assert.equal(turn.leads.length, 1);
      assert.match(turn.leads[0].context, /Байгууллагын каталог хүссэн — ажилтан хариулж байхад бот илгээгээгүй/);
      assert.match(turn.leads[0].context, /байгууллагын аялал/);
    });

    await context.test("the bot is paused for this customer: nothing is sent and staff see the request", async () => {
      harness.pause("paused-1", undefined, "manual");
      const turn = await say("paused-1", "hamt olnii aylal");
      assert.equal(turn.sends.length, 0);
      assert.equal(turn.leads.length, 1);
      assert.match(turn.leads[0].context, /Байгууллагын каталог хүссэн/);
    });

    await context.test("a staff reply seen in the Messenger thread takes the chat first: no catalogue", async () => {
      harness.thread("thread-1", { messages: [{ from: "customer", text: "сайн уу", agoMs: 3_600_000 }, { from: "page", text: "Сайн байна уу, би Болд байна", agoMs: 3_000_000, source: "mobile", id: "m_staff_1" }] });
      const before = meta.files.length;
      const turn = await say("thread-1", "компанийн аялал");
      assert.equal(turn.sends.length, 0);
      assert.equal(meta.files.length, before);
      assert.equal(harness.pauseState("thread-1")?.pause_reason, "operator_reply");
      assert.match(turn.leads[0].context, /Байгууллагын каталог хүссэн/);
    });

    await context.test("the page-wide pause and photo-only mode still turn a catalogue request into a lead", async () => {
      assert.equal(await noteBlockedCatalogueRequest({ platform: "facebook", senderId: "blocked-1", text: "байгууллагын аялал", reason: "photo_only" }), true);
      const lead = harness.leads.find((row) => row.sender_id === "blocked-1")!;
      assert.match(lead.context, /photo_only/);
      assert.equal(await noteBlockedCatalogueRequest({ platform: "facebook", senderId: "blocked-2", text: "Сайн байна уу", reason: "page_paused" }), false);
      assert.equal(harness.leads.some((row) => row.sender_id === "blocked-2"), false, "an ordinary message is not a catalogue lead");
      assert.equal(await noteBlockedCatalogueRequest({ platform: "facebook", senderId: "blocked-3", text: "A01 25 хүн 1-р сар", reason: "page_paused" }), true);
      assert.match(harness.leads.find((row) => row.sender_id === "blocked-3")!.context, /A01, 25 хүн, 1-р сар/);
    });

    await context.test("no published version: the customer is never left unanswered (website text) and staff get a lead; vague asks fall through to the trip flow", async () => {
      // Owner, launch 2026-11-07: an unavailable catalogue is acknowledged with the safe website text, not silence.
      stored.unpublish("quick"); stored.unpublish("complete");
      const explicit = await say("none-1", "байгууллагын аяллын каталог");
      assert.deepEqual(texts(explicit.sends), [catalogueStaleText("https://site.example.test")]);
      assert.equal(meta.files.filter((file) => file.recipientId === "none-1").length, 0, "no file to send");
      assert.equal(explicit.leads.length, 1);
      assert.match(explicit.leads[0].context, /нийтлэгдсэн каталог байхгүй/);
      assert.equal(stored.claims.at(-1)!.status, "stale_fallback");
      const vague = await say("none-2", "бүх аяллаа");
      assert.equal(vague.leads.filter((lead) => /Байгууллагын каталог/.test(lead.context)).length, 0, "the trip flow answers a vague ask");
      assert.ok(!texts(vague.sends).includes(sentCaption("complete")));
      stored.publish(quick); stored.publish(complete);
    });

    await context.test("a stale published file is not sent: one text with the website, a lead, flagged", async () => {
      const old = stored.publish({ ...quick, generatedAt: new Date(Date.now() - 30 * DAY).toISOString() });
      const turn = await say("stale-1", "байгууллагын аялал");
      assert.deepEqual(texts(turn.sends), [catalogueStaleText("https://site.example.test")]);
      assert.equal(meta.files.filter((file) => file.recipientId === "stale-1").length, 0);
      assert.equal(turn.leads.length, 1);
      assert.match(turn.leads[0].context, /хуучирсан/);
      assert.equal(stored.claims.find((claim) => claim.senderId === "stale-1")!.status, "stale_fallback");
      stored.publish({ ...old, generatedAt: quick.generatedAt });
      world.driftWith(["ТЕСТ-ДАЛАЙ — огноот үнэ өөрчлөгдсөн"]);
      const drifted = await say("stale-2", "байгууллагын аялал");
      assert.deepEqual(texts(drifted.sends), [catalogueStaleText("https://site.example.test")], "live prices moved: same safe fallback");
      world.failDrift();
      const unverified = await say("stale-3", "байгууллагын аялал");
      assert.deepEqual(texts(unverified.sends), [sentCaption("quick")], "an unreadable comparison does not silence the bot");
      world.driftWith([]);
    });

    await context.test("a specific-trip question is never turned into the catalogue", async () => {
      const files = meta.files.length;
      const price = await say("spec-1", "Тест-далай аяллын үнэ хэд вэ");
      assert.ok(!texts(price.sends).includes(sentCaption("quick")));
      assert.match(price.sends.map((send) => send.text).join("\n"), /ТЕСТ-ДАЛАЙ/, "the existing flow answered about that trip");
      const named = await say("spec-2", "Жишиг-хөдөө аяллын брошюр явуулаач");
      assert.ok(!texts(named.sends).includes(sentCaption("complete")), "a named trip's brochure is the trip flow's");
      assert.equal(meta.files.length, files, "no catalogue file");
      // A trip is already under discussion: 'брошюр' means that trip's, unless the customer says company or all.
      await say("spec-3", "Тест-далай аяллын үнэ хэд вэ");
      const brochure = await say("spec-3", "брошюр явуулаач");
      assert.ok(!texts(brochure.sends).includes(sentCaption("complete")));
      assert.equal(meta.files.length, files);
      const company = await say("spec-3", "байгууллагын аяллын каталог");
      assert.deepEqual(texts(company.sends), [sentCaption("quick")], "an explicit company request still gets the catalogue");
    });

    await context.test("a trip-code reply selects the trip, writes a structured lead and answers once, without price, date or booking", async () => {
      const turn = await say("code-1", "A01, 25 хүн, 1-р сар");
      assert.deepEqual(texts(turn.sends), [tripCodeAckText({ code: "A01", title: "ТЕСТ-ДАЛАЙ ЭРГИЙН АЯЛАЛ", groupSize: 25, month: 1 })]);
      assert.equal(turn.selection?.tripId, "t-dalai", "the conversation now points at the coded trip");
      assert.equal(turn.leads.length, 1);
      assert.equal(turn.leads[0].kind, "handoff");
      const context1 = turn.leads[0].context;
      assert.match(context1, /Код: A01/);
      assert.match(context1, /Аялал: ТЕСТ-ДАЛАЙ ЭРГИЙН АЯЛАЛ/);
      assert.match(context1, /Хүний тоо: 25/);
      assert.match(context1, /Сар: 1-р сар/);
      assert.match(context1, /"tripId":"t-dalai"/);
      assert.doesNotMatch(turn.sends[0].text, /₮|\d{1,3},\d{3}|2098|баталгаажлаа|захиалга авлаа|суудал/, "no price, date, seat or booking claim");
      assert.equal(turn.modelCalls + turn.answerModelCalls, 0);
    });

    await context.test("codes in every spelling resolve; a head count and month may come in later", async () => {
      for (const [sender, text, code, size, month] of [
        ["code-2", "A02 15 human 3 sar", "A02", 15, 3], ["code-3", "а02, 40 хүн", "A02", 40, null], ["code-4", "a2 10 hun 12-р сард", "A02", 10, 12],
      ] as const) {
        const turn = await say(sender, text);
        assert.equal(turn.selection?.tripId, "t-khudoo", text);
        assert.deepEqual(texts(turn.sends), [tripCodeAckText({ code, title: "ЖИШИГ-ХӨДӨӨ НУТГИЙН АЯЛАЛ", groupSize: size, month })], text);
        assert.match(turn.leads[0].context, new RegExp(`Код: ${code}`), text);
      }
      const bare = await say("code-5", "A01");
      assert.match(bare.sends[0].text, /хэдэн хүн, хэдэн сард/, "asks for what is missing, promises nothing");
    });

    await context.test("a phone number typed with the code is kept on the lead", async () => {
      const turn = await say("code-phone", "A02, 12 хүн, 3 сар, 99112233");
      assert.equal(turn.leads.length, 1);
      assert.equal(turn.leads[0].contact_phone, "99112233");
      assert.match(turn.leads[0].context, /Код: A02/);
      assert.equal(turn.sends.length, 1);
    });

    await context.test("an unknown code, or a code of a trip that is no longer offered, is silence plus a lead", async () => {
      const unknown = await say("code-9", "A77, 10 хүн, 2-р сар");
      assert.equal(unknown.sends.length, 0, "no data, no answer");
      assert.equal(unknown.selection, null);
      assert.equal(unknown.leads.length, 1);
      assert.match(unknown.leads[0].context, /Каталогид ийм код байхгүй/);
      const retired = await say("code-10", "A03 20 хүн 1-р сар");
      assert.equal(retired.sends.length, 0);
      assert.equal(retired.selection, null);
      assert.match(retired.leads[0].context, /идэвхгүй эсвэл нуугдсан/);
    });

    await context.test("a second code from the same customer adds to their open lead instead of losing it", async () => {
      await say("code-11", "A01, 25 хүн");
      const second = await say("code-11", "A02, 30 хүн, 2-р сар");
      assert.equal(second.leads.length, 0);
      const lead = harness.leads.find((row) => row.sender_id === "code-11")!;
      assert.match(lead.context, /Код: A01/);
      assert.match(lead.context, /Код: A02/);
      assert.equal(lead.status, "new", "unread again for staff");
    });

    await context.test("a code reply while staff own the chat is kept for them, not answered", async () => {
      harness.pause("code-12", undefined, "operator_reply");
      const turn = await say("code-12", "A01, 25 хүн, 1-р сар");
      assert.equal(turn.sends.length, 0);
      assert.match(turn.leads[0].context, /Каталогийн кодоор хариулсан/);
      assert.equal(turn.selection, null);
    });

    await context.test("a group quotation is handed to staff with what is known; the PDF is not the end of the sale", async () => {
      const before = meta.files.length;
      const turn = await say("quote-1", "30 хүнтэй байгууллагын аялалд үнийн санал гаргаж өгөөч");
      assert.deepEqual(texts(turn.sends), [groupQuoteText({ groupSize: 30, month: null })]);
      assert.equal(meta.files.length, before, "no PDF for a quotation request");
      assert.equal(turn.leads.length, 1);
      assert.match(turn.leads[0].context, /Бүлэг\/байгууллагын үнийн санал хүссэн/);
      assert.match(turn.leads[0].context, /Хүний тоо: 30/);
      assert.match(texts(turn.sends)[0], /хэдэн сард/);
      assert.doesNotMatch(texts(turn.sends)[0], /\d{1,3},\d{3}₮/);
    });

    await context.test("Meta rejects the file: the customer is told nothing false, gets ONE link, and staff are told", async () => {
      meta.rejectAttachmentOnce();
      meta.failFileOnce({ status: 400, errorCode: 100, errorMessage: "Invalid attachment id" });
      const files = meta.files.length;
      const turn = await say("reject-1", "хамт олны аяллын сонголтууд");
      assert.deepEqual(texts(turn.sends), [sentCaption("quick"), catalogueLinkFollowupText(publicUrlOf(quick.publicToken))]);
      assert.equal(meta.files.length, files + 2, "tried the cached id, then the fresh upload");
      assert.equal(turn.history.filter((row) => row.role === "assistant" && row.text === "").length, 0, "no file row for a file that was not sent");
      assert.equal(stored.claims.find((claim) => claim.senderId === "reject-1")!.status, "sent_link_fallback");
      assert.equal(turn.leads.length, 1);
      assert.match(turn.leads[0].context, /холбоос явуулсан/);
      assert.equal(turn.modelCalls + turn.answerModelCalls, 0);
    });

    await context.test("Meta is down for the caption: the webhook retries and the redelivery sends the catalogue once", async () => {
      const files = meta.files.length;
      harness.failSends("retry-1");
      const failed = await say("retry-1", "байгууллагын аялал", "mid-retry-1");
      assert.notEqual(failed.status, 200, "Meta is told to redeliver");
      assert.equal(failed.sends.length, 0);
      assert.equal(meta.files.length, files, "no file without its caption");
      harness.failSends("retry-1", false);
      const retried = await say("retry-1", "байгууллагын аялал", "mid-retry-1");
      assert.equal(retried.status, 200);
      assert.deepEqual(texts(retried.sends), [sentCaption("quick")]);
      assert.equal(meta.files.length, files + 1);
    });

    const captions = [sentCaption("quick"), sentCaption("complete")];
    const tookCatalogue = (turn: { sends: Array<{ text: string }> }) => texts(turn.sends).some((text) => captions.includes(text));
    const catalogueLeads = (turn: { leads: Array<{ context: string }> }) => turn.leads.filter((lead) => /Байгууллагын каталог|Каталогийн код|каталогоос үнийн санал/.test(lead.context));

    await context.test("a question that shares a word with the catalogue stays with the trip flow, in a trip conversation and out of it", async () => {
      const files = meta.files.length;
      await say("fp-1", "Тест-далай аяллын үнэ хэд вэ"); // a trip is now under discussion: "all" and "group" belong to it
      for (const text of ["энэ аялалд бүх зүйл багтсан уу", "энэ аяллын бүх хөтөлбөр", "энэ групп аялал уу", "энэ аялал багийн хэдэн хүнтэй вэ", "энэ аяллыг байгууллагаар явж болох уу"]) {
        const turn = await say("fp-1", text);
        assert.equal(tookCatalogue(turn), false, text);
        assert.equal(catalogueLeads(turn).length, 0, text);
      }
      for (const text of ["аяллын бүх зардал багтсан уу", "бүтэн өдрийн аялал байна уу", "бүх нийтийн баярын аялал байна уу", "full day tour", "very nice trip",
        "групп аялал байна уу", "аялал жуулчлалын компани уу", "Bulgaria trip", "companion tour", "дахин баярлалаа"]) {
        const turn = await say("fp-2", text);
        assert.equal(tookCatalogue(turn), false, text);
        assert.equal(catalogueLeads(turn).length, 0, text);
      }
      assert.equal(meta.files.length, files, "no file for an ordinary question");
      // Recall is kept: listing every trip is a catalogue request even mid-conversation, and so is the usual spelling of "corporate".
      assert.deepEqual(texts((await say("fp-1", "бүх аяллаа харуулаач")).sends), [sentCaption("complete")]);
      assert.deepEqual(texts((await say("fp-3", "Корпорэйт аялал")).sends), [sentCaption("quick")]);
    });

    await context.test("'again' beside thanks, a question or another thing is not a request to send the file again", async () => {
      await say("thx-1", "каталог явуул");
      const files = meta.files.length;
      context.mock.timers.setTime(Date.now() + 3 * 60_000);
      for (const text of ["баярлалаа дахин хандъя", "дахиад нэг асуулт байна", "үнийг дахиад хэлээч", "thanks again", "дахин баярлалаа"]) {
        const turn = await say("thx-1", text);
        assert.equal(tookCatalogue(turn), false, text);
        assert.equal(catalogueLeads(turn).length, 0, text);
      }
      assert.equal(meta.files.length, files, "no unsolicited attachment");
      await say("thx-1", "дахин явуул");
      assert.equal(meta.files.length, files + 1, "a real request to send it again is still honoured");
    });

    await context.test("a customer who asks again minutes later is pointed at the file they already have: not silence, not a second file", async () => {
      await say("rep-1", "байгууллагын аялал");
      const files = meta.files.length;
      assert.equal((await say("rep-1", "байгууллагын аялал")).sends.length, 0, "a double tap seconds later stays silent");
      context.mock.timers.setTime(Date.now() + 10 * 60_000);
      const again = await say("rep-1", "байгууллагын аяллын каталог явуулаач", "mid-rep-2");
      assert.deepEqual(texts(again.sends), [catalogueRepeatText({ url: publicUrlOf(quick.publicToken), linkOnly: false })]);
      assert.equal(meta.files.length, files, "never a second file");
      assert.equal(catalogueLeads(again).length, 0, "answered in the chat");
      assert.equal(stored.claims.filter((claim) => claim.senderId === "rep-1").length, 1, "the repeat took no send slot");
      assert.equal((await say("rep-1", "байгууллагын аяллын каталог явуулаач", "mid-rep-2")).sends.length, 0, "the same message redelivered is not answered twice");
    });

    await context.test("after the website notice, a freshly published file reaches the customer who asked again", async () => {
      stored.publish({ ...quick, generatedAt: new Date(Date.now() - 30 * DAY).toISOString() });
      const first = await say("fresh-1", "байгууллагын аялал");
      assert.deepEqual(texts(first.sends), [catalogueStaleText("https://site.example.test")]);
      context.mock.timers.setTime(Date.now() + 10 * 60_000);
      const fresh = stored.publish(makeVersion({ edition: "quick", id: "00000000-0000-4000-8000-0000000000a2", versionNo: 4, fileName: "UUDAM_Corporate_2098-01-31_v4.pdf", publicToken: "tok_quick_000000000002" }));
      const files = meta.files.length;
      const second = await say("fresh-1", "байгууллагын аяллын каталог явуулаач");
      assert.deepEqual(texts(second.sends), [sentCaption("quick")], "the stale notice does not hold the new version back for six hours");
      assert.equal(meta.files.length, files + 1);
      assert.deepEqual(stored.claims.filter((claim) => claim.senderId === "fresh-1").map((claim) => [claim.versionId, claim.status]), [[quick.id, "stale_fallback"], [fresh.id, "sent"]]);
      stored.publish(quick);
    });

    await context.test("a question about a coded trip is not swallowed by the quotation acknowledgement", async () => {
      for (const [sender, text, tripId] of [["codeq-1", "A01 хөтөлбөр юу вэ", "t-dalai"], ["codeq-2", "A02 үнэ хэд вэ", "t-khudoo"], ["codeq-3", "A02 ямар зочид буудал вэ?", "t-khudoo"]] as const) {
        const turn = await say(sender, text);
        assert.ok(!texts(turn.sends).some((reply) => /гэж бүртгэлээ/.test(reply)), `${text}: no quotation acknowledgement`);
        assert.equal(catalogueLeads(turn).length, 0, `${text}: no quotation lead`);
        assert.equal(turn.selection?.tripId, tripId, `${text}: the conversation now points at the coded trip`);
      }
      const retired = await say("codeq-4", "A03 хөтөлбөр юу вэ");
      assert.equal(retired.selection, null, "a retired trip is not selected");
      assert.equal(catalogueLeads(retired).length, 0);
    });

    await context.test("a code written inside a sentence is found; an unknown one inside a sentence is left alone", async () => {
      const greeting = await say("codes-1", "Сайн байна уу, A02 аяллыг сонирхож байна");
      assert.deepEqual(texts(greeting.sends), [tripCodeAckText({ code: "A02", title: "ЖИШИГ-ХӨДӨӨ НУТГИЙН АЯЛАЛ", groupSize: null, month: null })]);
      assert.match(greeting.leads[0].context, /Код: A02/, "the code is on the staff lead");
      assert.equal(greeting.selection?.tripId, "t-khudoo");
      const bare = await say("codes-2", "Сайн байна уу A01");
      assert.match(bare.sends[0].text, /A01 · ТЕСТ-ДАЛАЙ ЭРГИЙН АЯЛАЛ/);
      for (const text of ["hotel C1 5 hun", "миний утас B21 байна", "Сайн байна уу, A77 гэж юу вэ"]) {
        const turn = await say("codes-3", text);
        assert.equal(catalogueLeads(turn).length, 0, `${text}: not a catalogue reply, no lead about a code`);
        assert.equal(turn.selection, null, text);
      }
    });

    await context.test("a day of the month or a year in a code reply is never read as the head count", async () => {
      const day = await say("date-1", "A01 3-р сарын 15");
      assert.deepEqual(texts(day.sends), [tripCodeAckText({ code: "A01", title: "ТЕСТ-ДАЛАЙ ЭРГИЙН АЯЛАЛ", groupSize: null, month: 3 })]);
      assert.match(day.leads[0].context, /Хүний тоо: бичээгүй/);
      assert.match(day.leads[0].context, /Сар: 3-р сар/);
      const year = await say("date-2", "A01 2027 оны 1-р сар");
      assert.deepEqual(texts(year.sends), [tripCodeAckText({ code: "A01", title: "ТЕСТ-ДАЛАЙ ЭРГИЙН АЯЛАЛ", groupSize: null, month: 1 })]);
      assert.match(year.leads[0].context, /Хүний тоо: бичээгүй/);
    });

    await context.test("ordinary conversations are untouched", async () => {
      const files = meta.files.length;
      for (const text of ["Сайн байна уу", "Тест-далай хэд хоног вэ", "гэр бүлийн аялал байна уу", "утасны дугаар хэд вэ"]) {
        const turn = await say("plain-1", text);
        assert.ok(!texts(turn.sends).includes(sentCaption("quick")) && !texts(turn.sends).includes(sentCaption("complete")), text);
        assert.equal(turn.leads.filter((lead) => /Байгууллагын каталог|Каталогийн код/.test(lead.context)).length, 0, text);
      }
      assert.equal(meta.files.length, files);
    });
  } finally {
    await world.close();
  }
});

/**
 * "Тестер холбох": a staff member proves their own Messenger account by sending a one-time code to the
 * Page. Through the real signed webhook; storage and Meta are in-memory fakes. The code is the only
 * thing that registers a tester: a sentence, a near miss, an expired, used or stranger's code, a
 * guesser, and a conversation staff own all register nobody.
 */
test("catalogue tester pairing journeys", async (context) => {
  const world = await setup(context);
  const { harness, meta, stored, say, texts } = world;
  const testers = await import("../src/lib/catalogue/testers");
  const { memoryTesterStore } = await import("./helpers/testerFakes");
  const { sendCatalogueTest } = await import("../src/lib/catalogue/send");
  const mem = memoryTesterStore(() => Date.now());
  const codes: string[] = [];
  testers.setTesterRuntimeForTests({ store: mem.store, code: () => codes.shift()! });
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    context.mock.method(console, level, (...args: unknown[]) => { lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")); });
  }
  const issue = async (code: string, label = "Миний утас") => {
    codes.push(code);
    return testers.createPairingCode({ actor: "owner.test@example.test", label });
  };
  const paired = async () => (await testers.listTesters()).map((tester) => tester.masked).sort();
  const advance = (ms: number) => context.mock.timers.setTime(Date.now() + ms);
  const ACK = testers.TESTER_PAIRED_TEXT;
  try {
    await context.test("the staff member's own account is registered by the exact code: one short acknowledgement, nothing else", async () => {
      const { code } = await issue("UUDAM-TEST-7K3Q9X");
      const turn = await say("tester-psid-001", code);
      assert.deepEqual(texts(turn.sends), [ACK]);
      assert.equal(ACK, "Тестийн бүртгэл амжилттай. Админ дээрээс каталогийг илгээж болно.");
      assert.equal(turn.modelCalls + turn.answerModelCalls, 0, "no AI spend");
      assert.equal(turn.leads.length, 0, "a pairing is not a customer lead");
      assert.equal(meta.files.length, 0, "no catalogue is sent by a pairing");
      assert.equal(turn.history.some((row) => row.text.includes(code)), false, "the one-time code is never written to the conversation history");
      const [tester] = await testers.listTesters();
      assert.equal(tester.label, "Миний утас");
      assert.equal(tester.masked, "…-001");
      assert.equal(tester.windowOpen, true, "they just wrote to the Page");
      assert.deepEqual(Object.keys(tester).sort(), ["id", "label", "lastInboundAt", "masked", "verifiedAt", "windowClosesAt", "windowOpen"], "the browser view has no PSID field");
      assert.equal(mem.codes.get(testers.hashTesterCode(code))?.consumedAt !== null, true, "the code is burnt");
    });

    await context.test("phone autocorrect (lower case, spaces) is forgiven", async () => {
      const { code } = await issue("UUDAM-TEST-ABCD23", "Хоёр дахь утас");
      const turn = await say("tester-psid-002", `  ${code.toLowerCase()} `);
      assert.deepEqual(texts(turn.sends), [ACK]);
      assert.deepEqual(await paired(), ["…-001", "…-002"]);
    });

    await context.test("a replayed code, and a second account using the same code, register nobody", async () => {
      const again = await say("tester-psid-001", "UUDAM-TEST-7K3Q9X");
      assert.ok(!texts(again.sends).includes(ACK), "a burnt code is not acknowledged again");
      const stranger = await say("customer-stranger", "UUDAM-TEST-7K3Q9X");
      assert.ok(!texts(stranger.sends).includes(ACK));
      assert.deepEqual(await paired(), ["…-001", "…-002"], "still the two original accounts");
    });

    await context.test("a customer typing something code-like is not registered, and the live code is not burnt by them", async () => {
      const { code } = await issue("UUDAM-TEST-K2M3N4");
      for (const text of [`${code} байна уу`, `миний код ${code}`, "UUDAM-TEST-K2M3N", `${code}9`, "UUDAM-TEST-K2M3N0", "uudam test K2M3N4", `${code}\nA01`]) {
        const turn = await say("customer-curious", text);
        assert.ok(!texts(turn.sends).includes(ACK), `${JSON.stringify(text)} is not a pairing`);
      }
      assert.deepEqual(await paired(), ["…-001", "…-002"]);
      assert.equal(mem.codes.get(testers.hashTesterCode(code))?.consumedAt, null, "the code is still unused");
      const real = await say("tester-psid-003", code);
      assert.deepEqual(texts(real.sends), [ACK], "the real owner of the code can still use it");
    });

    await context.test("an expired code registers nobody", async () => {
      const { code } = await issue("UUDAM-TEST-P5Q6R7");
      advance(31 * 60_000);
      const turn = await say("tester-psid-late", code);
      assert.ok(!texts(turn.sends).includes(ACK));
      assert.equal((await paired()).includes("…late"), false);
    });

    await context.test("a conversation staff own never reaches the pairing, and the code stays live", async () => {
      const { code } = await issue("UUDAM-TEST-S8T9U2");
      harness.pause("tester-owned", undefined, "operator_reply");
      const turn = await say("tester-owned", code);
      assert.equal(turn.sends.length, 0);
      assert.equal(mem.codes.get(testers.hashTesterCode(code))?.consumedAt, null);
      assert.equal((await paired()).includes("…wned"), false);
    });

    await context.test("a guesser is stopped after five code-shaped tries, even with the right code, until the window passes", async () => {
      const { code } = await issue("UUDAM-TEST-V3W4X5");
      for (const wrong of ["UUDAM-TEST-AAAAA2", "UUDAM-TEST-AAAAA3", "UUDAM-TEST-AAAAA4", "UUDAM-TEST-AAAAA5", "UUDAM-TEST-AAAAA6"]) await say("tester-guesser", wrong);
      const blocked = await say("tester-guesser", code);
      assert.ok(!texts(blocked.sends).includes(ACK), "the sixth try is refused even though the code is right");
      advance(11 * 60_000);
      const later = await say("tester-guesser", code);
      assert.deepEqual(texts(later.sends), [ACK]);
    });

    await context.test("a real test send reaches only the verified tester: one text, one file, window, revoke and kill switch honoured", async () => {
      const [first] = (await testers.listTesters()).filter((tester) => tester.masked === "…-001");
      const direct: Array<{ recipient: string; text: string }> = [];
      let kill = false;
      let pageStop: { status: "blocked_paused"; reason: string } | null = null;
      const deps = {
        sendDirectText: async (recipient: string, text: string) => { direct.push({ recipient, text }); return true; },
        gate: async () => ({ status: "blocked_staff_owned" as const, reason: "operator_reply" }),
        pageGate: async () => pageStop,
        killSwitch: () => kill,
        assertMaySend: async () => { throw new Error("a verified tester's own conversation is not checked for staff takeover"); },
      };
      const send = (dryRun: boolean) => sendCatalogueTest({ recipientPsid: "", testerId: first.id, edition: "quick", dryRun, env: {}, deps });

      const dry = await send(true);
      assert.deepEqual(dry.payload?.messages.map((message) => message.kind), ["text", "file"], "exactly one text and one file");
      assert.equal(JSON.stringify(dry).includes("tester-psid-001"), false);
      assert.equal(direct.length + meta.files.length, 0, "a dry run sends nothing");

      const before = meta.files.length;
      const sent = await send(false);
      assert.deepEqual([sent.ok, sent.status], [true, "sent"]);
      assert.deepEqual(direct, [{ recipient: "tester-psid-001", text: catalogueCaption("quick") }]);
      assert.equal(meta.files.length, before + 1);
      assert.equal(meta.files.at(-1)!.recipientId, "tester-psid-001");
      assert.equal(stored.claims.some((claim) => claim.senderId === "tester-psid-001"), false, "a test takes no customer send slot");

      pageStop = { status: "blocked_paused", reason: "page_paused" };
      assert.equal((await send(false)).status, "blocked_paused");
      pageStop = null;
      kill = true;
      assert.equal((await send(false)).status, "blocked_killswitch");
      kill = false;
      const filesNow = meta.files.length;

      advance(25 * 3_600_000);
      const closed = await send(false);
      assert.deepEqual([closed.status, closed.reason], ["blocked_window", "outside_24h_window"]);
      assert.equal(meta.files.length, filesNow, "nothing leaves outside the 24 h window");
      assert.equal((await testers.listTesters()).find((tester) => tester.id === first.id)!.windowOpen, false);

      mem.wroteToPage("tester-psid-001");
      assert.equal((await testers.listTesters()).find((tester) => tester.id === first.id)!.windowOpen, true, "the webhook's last-seen reopens the window");
      assert.equal((await send(false)).status, "sent");

      assert.equal(await testers.revokeTester(first.id, "owner.test@example.test"), true);
      const revoked = await send(false);
      assert.deepEqual([revoked.ok, revoked.error], [false, "tester_revoked"]);
      assert.equal((await paired()).includes("…-001"), false);
    });

    await context.test("the admin flow end to end: code -> polls -> the message -> paired and selected; expiry; re-pairing a known device; revoke", async () => {
      const flow = await import("../src/components/admin/catalogue/pairingFlow");
      const poll = async (state: import("../src/components/admin/catalogue/pairingFlow").PairingState) =>
        flow.reducePairing(state, { type: "polled", testers: await testers.listTesters(), nowMs: Date.now() });
      advance(1000);

      // 1. A new device: press the button, get a code, nothing happens until the message arrives.
      let state = flow.reducePairing(flow.initialPairing, { type: "request", testers: await testers.listTesters() });
      assert.equal(state.phase, "issuing");
      const first = await issue("UUDAM-TEST-Z9Y8X7", "Миний шинэ утас");
      state = flow.reducePairing(state, { type: "issued", response: first, nowMs: Date.now() });
      assert.equal(state.phase, "waiting");
      assert.equal(state.code, "UUDAM-TEST-Z9Y8X7");
      assert.equal(flow.shouldPoll(state, false), true);
      assert.equal(flow.shouldPoll(state, true), false, "no polling while the tab is hidden");
      assert.equal(flow.formatCountdown(flow.remainingMs(state, Date.now())), "30:00");
      advance(3000);
      state = await poll(state);
      assert.equal(state.phase, "waiting", "a poll before the message changes nothing");

      const turn = await say("tester-psid-flow", first.code);
      assert.deepEqual(texts(turn.sends), [ACK]);
      advance(3000);
      state = await poll(state);
      assert.equal(state.phase, "paired", "the next poll sees the new tester");
      const pairedTester = (await testers.listTesters()).find((tester) => tester.masked === "…flow")!;
      assert.equal(state.testerId, pairedTester.id, "and selects exactly that tester");
      assert.equal(flow.shouldPoll(state, false), false, "polling stops once paired");
      assert.deepEqual(flow.testReadiness({ testers: await testers.listTesters(), selectedId: state.testerId, metaOutboundDisabled: false }), { kind: "ready", testerId: pairedTester.id });

      // 2. A code nobody uses expires on the countdown, and the polling stops with it.
      state = flow.reducePairing(flow.initialPairing, { type: "request", testers: await testers.listTesters() });
      state = flow.reducePairing(state, { type: "issued", response: await issue("UUDAM-TEST-E1E2E3"), nowMs: Date.now() });
      advance(31 * 60_000);
      state = flow.reducePairing(state, { type: "tick", nowMs: Date.now() });
      assert.equal(state.phase, "expired");
      assert.equal(flow.shouldPoll(state, false), false);
      assert.ok(!texts((await say("tester-psid-flow", "UUDAM-TEST-E1E2E3")).sends).includes(ACK), "the expired code is refused");
      assert.equal((await testers.listTesters()).filter((tester) => tester.masked === "…flow").length, 1, "an expired code registers nobody new");

      // 3. Pairing the SAME device again registers no new tester but still counts as paired.
      advance(1000);
      state = flow.reducePairing(flow.initialPairing, { type: "request", testers: await testers.listTesters() });
      state = flow.reducePairing(state, { type: "issued", response: await issue("UUDAM-TEST-R4R5R6"), nowMs: Date.now() });
      advance(2000);
      state = await poll(state);
      assert.equal(state.phase, "waiting");
      advance(1000);
      assert.deepEqual(texts((await say("tester-psid-flow", "UUDAM-TEST-R4R5R6")).sends), [ACK]);
      advance(1000);
      state = await poll(state);
      assert.deepEqual([state.phase, state.testerId], ["paired", pairedTester.id], "the known device is recognised by its fresh message");

      // 4. Revoked afterwards: the button explains it instead of sending.
      assert.equal(await testers.revokeTester(pairedTester.id, "owner.test@example.test"), true);
      assert.deepEqual(flow.testReadiness({ testers: await testers.listTesters(), selectedId: pairedTester.id, metaOutboundDisabled: false }), { kind: "revoked" });
    });

    await context.test("neither the raw PSID of a tester nor a pairing code reached any log", async () => {
      const text = lines.join("\n");
      for (const secret of ["tester-psid-001", "tester-psid-002", "tester-psid-003", "tester-psid-flow", "customer-stranger", "UUDAM-TEST-7K3Q9X", "UUDAM-TEST-ABCD23", "UUDAM-TEST-K2M3N4", "UUDAM-TEST-V3W4X5", "UUDAM-TEST-Z9Y8X7", "UUDAM-TEST-R4R5R6"]) {
        assert.equal(text.includes(secret), false, `${secret} must not be logged`);
      }
      assert.ok(lines.some((line) => line.includes("catalogue.tester_pairing")), "pairing outcomes are logged (hashed sender, status only)");
    });
  } finally {
    testers.setTesterRuntimeForTests(null);
    await world.close();
  }
});

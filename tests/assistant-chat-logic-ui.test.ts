/**
 * The assistant tab's page-side decisions (src/components/admin/assistantChatLogic.ts and the
 * save outcomes in src/lib/adminProposalApply.ts). Invented trip names and links only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  RELOAD_DURING_DIRECT_SAVE_TEXT, RELOAD_DURING_SAVE_TEXT, THREAD_TTL_MS, agentProgressStages, answerToOf, attachmentRoute, displayText,
  instructionBody, isPhotoInstruction, isSaveLocked, openAskOf, proposalMessage, replyCaption, replyMetaOf, replyToMessage, restoreThread,
  serializeThread, stageAt, unlockSave,
} from "../src/components/admin/assistantChatLogic";
import type { AssistantAskMsg, AssistantChatMessage, AssistantProposalMsg } from "../src/components/admin/assistantChatTypes";
import { APPLY_WAIT_MS, applyOutcome } from "../src/lib/adminProposalApply";
import type { AIProposal, AttachedFile } from "../src/lib/adminTypes";

const file = (name: string, mimeType: string): AttachedFile => ({ id: name, name, mimeType, sizeBytes: 1000, file: {} as File });
const photoA = file("lake.jpg", "image/jpeg");
const photoB = file("forest.png", "image/png");
const pdf = file("program.pdf", "application/pdf");

test("photos with an explicit photo edit go to the agent; documents and bare photos keep the file reader", () => {
  for (const words of [
    "3-р өдрийн зургийг энэ зургаар соль", "нүүр зураг солих", "2-р зургийг соль", "zurgiig soli", "replace the cover photo", "фото солих",
    "2-р зургийг хас", "«Вэлмор» аяллын нүүр зургийг энэ зургаар соль", "3-r udriin zurgiig soli", "нүүр зураг болго", "3 дахь өдрийн зураг энэ",
    "эхний зургийг устга, оронд нь энийг тавь", "replace the day 3 photo",
  ]) {
    assert.equal(isPhotoInstruction(words), true, words);
  }
  for (const words of ["Солонгос аялал нэм", "үнийг шинэчил", "12/2 дүүрсэн", "соль", "энэ жагсаалтаар соль", "энэ зургаар шинэчил", "зураг"]) {
    assert.equal(isPhotoInstruction(words), false, words);
  }

  const route = attachmentRoute("«Вэлмор» 3-р өдрийн зургийг соль", [photoA, photoB]);
  assert.equal(route.kind, "agent_images");
  assert.equal(route.kind === "agent_images" && route.images.length, 2);

  assert.equal(attachmentRoute("", [photoA]).kind, "files", "a photo with no words is a price list or poster to read");
  assert.equal(attachmentRoute("энэ прайсыг уншаад шинэчил", [photoA]).kind, "files", "a photo with no photo instruction is read as a source");
  assert.equal(attachmentRoute("зургийг соль", [photoA, pdf]).kind, "files", "a document keeps the file reader");
  assert.equal(attachmentRoute("зургийг соль", []).kind, "none");
  // The agent sees an attachment only as a link: a poster or price list sent with these words must be read.
  for (const words of [
    "энэ зургаас шинэ аялал үүсгэ", "«Вэлмор» аяллын үнийг энэ жагсаалтаар соль", "үнийн хүснэгтийн зураг, үнийг шинэчил",
    "энэ зурган дээрх үнээр шинэчил", "zurgaas unshaad shine aylal nem", "энэ постерын зургаар аялал нэм", "зургаас хөтөлбөрийг уншаад 3-р өдрийг соль",
    "энэ зургийн огноогоор солих", "энэ зургаар шинэчил", "replace prices from this photo",
  ]) {
    assert.equal(attachmentRoute(words, [photoA]).kind, "files", words);
  }

  const many = Array.from({ length: 8 }, (_, index) => file(`p${index}.jpg`, "image/jpeg"));
  const capped = attachmentRoute("зургуудыг соль", many);
  assert.ok(capped.kind === "agent_images" && capped.images.length === 6 && capped.skipped === 2, "at most six photos per instruction");
});

test("one request: a typed answer carries its question; attachments travel as hosted image links", () => {
  const answerTo = { id: "agent", question: "Аль өдрийн үнэ вэ?", instruction: "«Вэлмор» үнийг 100 мянгаар нэм" };
  assert.deepEqual(instructionBody({ instruction: "12/2", sessionId: "s-1", answerTo }), { instruction: "12/2", session_id: "s-1", answer_to: answerTo });
  assert.deepEqual(instructionBody({ instruction: "x", sessionId: "s-1" }), { instruction: "x", session_id: "s-1" }, "nothing extra on a plain instruction");
  const body = instructionBody({
    instruction: "3-р өдрийн зургийг соль", sessionId: "s-1",
    attachments: [{ url: "https://res.cloudinary.com/fixture/image/upload/v1/a.jpg", kind: "image" }, { url: "http://insecure.example/b.jpg", kind: "image" }],
  });
  assert.deepEqual(body.attachments, [{ url: "https://res.cloudinary.com/fixture/image/upload/v1/a.jpg", kind: "image" }], "only https links are sent");
});

test("the composer answers a question only while it is the assistant's latest word", () => {
  const ask: AssistantAskMsg = { id: "a1", role: "assistant", kind: "ask", text: "Аль өдөр вэ?", options: [], answerTo: { question: "Аль өдөр вэ?", instruction: "«Вэлмор» дүүрсэн" } };
  const thread: AssistantChatMessage[] = [{ id: "m1", role: "admin", text: "«Вэлмор» дүүрсэн" }, ask];
  assert.equal(openAskOf(thread)?.id, "a1");
  assert.equal(openAskOf([...thread, { id: "m2", role: "admin", text: "12/2" }])?.id, "a1", "the admin's own line does not close it");
  assert.equal(openAskOf([...thread, { id: "n1", role: "assistant", kind: "note", tone: "info", text: "…" }]), null, "a later reply closes it");
  assert.equal(openAskOf([{ ...ask, answered: "12/2" }]), null);
  assert.deepEqual(answerToOf(ask), ask.answerTo);
  assert.deepEqual(answerToOf({ ...ask, answerTo: undefined }), { question: "Аль өдөр вэ?" }, "an older ask still says what was asked");
});

test("a tapped option's trip tag travels to the server but never reaches the screen", () => {
  assert.equal(displayText("«Вэлмор» 12/2 дүүрсэн болго [сонгосон аялал: «ВЭЛМОР НУУРЫН АЯЛАЛ» id:trip-velmor]"), "«Вэлмор» 12/2 дүүрсэн болго");
  assert.equal(displayText("«ВЭЛМОР» [аялал: «ВЭЛМОР» trip_id=trip-velmor] (trip:1)"), "«ВЭЛМОР»");
  assert.equal(displayText("12/2 [огноо: 2099-12-02]"), "12/2");
});

test("the progress line follows the agent's usual steps and reads the link when there is one", () => {
  const plain = agentProgressStages("«Вэлмор» 12/2 дүүрсэн");
  assert.deepEqual(plain.map((stage) => stage.label).slice(0, 2), ["Ойлгож байна…", "Аяллыг шалгаж байна…"]);
  assert.equal(plain.some((stage) => stage.label.includes("Холбоос")), false);
  const linked = agentProgressStages("https://uudamtravel.mn/mn/trips/trip-0123456789abcdef0123 устга");
  assert.ok(linked.some((stage) => stage.label === "Холбоосыг уншиж байна…"));
  assert.equal(stageAt(linked, 0), "Ойлгож байна…");
  assert.equal(stageAt(linked, 3), "Холбоосыг уншиж байна…");
  assert.equal(stageAt(linked, 9), "Аяллыг шалгаж байна…");
});

test("how a reply was made: the agent's steps, and «энгийн горим» when the brain answered a typed instruction", () => {
  const agent = replyMetaOf({ source: "agent", steps: ["search_trips", "get_trip", "get_trip", "propose_changes"] }, "«Вэлмор» 12/2 дүүрсэн");
  assert.equal(replyCaption(agent), "AI туслах · аялал хайсан · аяллыг шалгасан");
  const simple = replyMetaOf({ source: "brain" }, "«Вэлмор» 12/2 дүүрсэн");
  assert.equal(simple?.simple, true);
  assert.match(replyCaption(simple) || "", /^Энгийн горим/);
  const tapped = replyMetaOf({ source: "brain" }, "«Вэлмор» цуцал [аялал: «ВЭЛМОР» trip_id=trip-velmor]");
  assert.equal(tapped?.simple, undefined, "a tapped brain option is the brain on purpose");
  assert.equal(replyCaption(tapped), null);
  const fallbackProposal = { summary: "x", needs_confirmation: true, important_reason: "", conflicts: [], actions: [{ action: "patch", trip_id: "t" }],
    conflict_items: [{ text: "AI түр ажиллахгүй…", severity: "info" as const, type: "ai_fallback" }] };
  assert.equal(replyMetaOf({ source: "brain", proposal: fallbackProposal }, "trip_id=t")?.simple, true, "the route's own fallback note marks it too");
});

test("a proposal with no actions but a question becomes buttons, answered on its stored request (B5)", () => {
  const proposal: AIProposal = {
    summary: "Аль аялал вэ?", needs_confirmation: true, important_reason: "", conflicts: [], actions: [],
    questions: [{
      id: "trip:1", prompt: "«Вэлмор» гэж аль аяллыг хэлж байна?", allow_custom: true, custom_placeholder: "Аяллын нэрийг яг бичнэ үү",
      options: [
        { label: "ВЭЛМОР НУУРЫН АЯЛАЛ", hint: "идэвхтэй", answer: "«ВЭЛМОР НУУРЫН АЯЛАЛ» [аялал: «ВЭЛМОР НУУРЫН АЯЛАЛ» trip_id=trip-velmor] (trip:1)" },
        { label: "ВЭЛМОР – ӨВЛИЙН АЯЛАЛ", answer: "«ВЭЛМОР – ӨВЛИЙН АЯЛАЛ» [аялал: «ВЭЛМОР – ӨВЛИЙН АЯЛАЛ» trip_id=trip-velmor-2] (trip:1)" },
      ],
    }],
  };
  const message = replyToMessage({ ok: true, proposal, request_id: 41, source: "agent" }, { id: "r1", sent: "вэлмор 12/2 дүүрсэн" });
  assert.equal(message.role === "assistant" && message.kind, "ask");
  const ask = message as AssistantAskMsg;
  assert.equal(ask.requestId, 41, "the answer goes back to request 41");
  assert.equal(ask.options.length, 2);
  assert.equal(ask.options[0].hint, "идэвхтэй");
  assert.equal(ask.allowCustom, true);

  const none = replyToMessage({ ok: true, proposal: { ...proposal, questions: [], conflicts: ["Аялал олдсонгүй."], conflict_items: [{ text: "Аялал олдсонгүй.", severity: "blocker" }] } }, { id: "r2", sent: "x" });
  assert.ok(none.role === "assistant" && none.kind === "note" && none.tone === "error" && none.text === "Аялал олдсонгүй.");
});

test("an ask keeps the route's answer_to so a typed answer is read with its question", () => {
  const answerTo = { id: "agent", question: "Хэдэн төгрөгөөр нэмэх вэ?", instruction: "«Вэлмор» 12/2-ны үнийг нэм" };
  const message = replyToMessage({ ok: true, source: "agent", ask: { id: "agent", text: "Хэдэн төгрөгөөр нэмэх вэ?", options: [], allow_custom: true, answer_to: answerTo } }, { id: "q1", sent: "«Вэлмор» 12/2-ны үнийг нэм" });
  assert.ok(message.role === "assistant" && message.kind === "ask");
  assert.deepEqual((message as AssistantAskMsg).answerTo, answerTo);
  assert.equal((message as AssistantAskMsg).meta?.source, "agent");
});

test("the thread survives a reload for six hours, then starts fresh; broken storage is ignored", () => {
  const now = 1_000_000_000_000;
  const thread: AssistantChatMessage[] = [
    { id: "intro", role: "assistant", kind: "note", tone: "info", text: "Сайн байна уу" },
    { id: "m1", role: "admin", text: "«Вэлмор» 12/2 дүүрсэн" },
    { id: "a1", role: "assistant", kind: "ask", text: "Аль аялал вэ?", options: [{ label: "A", answer: "A [сонгосон аялал: «A» id:t-a]" }] },
  ];
  assert.equal(serializeThread("s-1", thread.slice(0, 1), now), null, "the greeting alone is not stored");
  const raw = serializeThread("s-1", thread, now);
  assert.ok(raw);
  const back = restoreThread(raw, now + 60_000);
  assert.equal(back?.sessionId, "s-1");
  assert.deepEqual(back?.messages, thread);
  assert.equal(restoreThread(raw, now + THREAD_TTL_MS + 1), null, "older than the server remembers");
  assert.equal(restoreThread("{not json", now), null);
  assert.equal(restoreThread(JSON.stringify({ v: 1, sessionId: "s", savedAt: now, messages: [{ role: "admin" }] }), now), null, "malformed rows are dropped");
});

function pendingCard(over: Partial<AssistantProposalMsg> = {}): AssistantProposalMsg {
  const proposal: AIProposal = { summary: "«Вэлмор» 2/10 дүүрсэн", needs_confirmation: true, important_reason: "", conflicts: [],
    actions: [{ action: "set_date_state", trip_id: "trip-velmor", date: "2099-02-10", state: "full" } as unknown as AIProposal["actions"][number]] };
  return { ...proposalMessage(proposal, 41, { id: "p1", sent: "«Вэлмор» 2/10 дүүрсэн" }), ...over };
}
const stored = (messages: AssistantChatMessage[], now: number) => serializeThread("s-1", [{ id: "m1", role: "admin", text: "«Вэлмор» 2/10 дүүрсэн" }, ...messages], now) as string;
const restoredCard = (raw: string, now: number) => restoreThread(raw, now)?.messages.find((message) => message.id === "p1") as AssistantProposalMsg;

test("a save still running when the page reloads keeps Save off on the restored card, and says the outcome is unknown", () => {
  const now = 1_000_000_000_000;
  const until = now + APPLY_WAIT_MS;
  const raw = stored([pendingCard({ saveLockedUntil: until })], now);
  assert.match(raw, /saveLockedUntil/, "the lock is stored with the thread");

  const soon = restoredCard(raw, now + 5_000);
  assert.equal(soon.status, "pending");
  assert.equal(soon.saveLockedUntil, until, "Save stays off until the server has certainly stopped");
  assert.equal(isSaveLocked(soon, now + 5_000), true);
  assert.equal(soon.saveUnknown, true);
  assert.equal(soon.saveError, RELOAD_DURING_SAVE_TEXT);
  assert.doesNotMatch(soon.saveError || "", /Хадгалагдсангүй/u, "never a false 'not saved'");

  const later = restoredCard(raw, until + 1_000);
  assert.equal(later.saveLockedUntil, undefined, "after the server's limit Save comes back (and then asks the server)");
  assert.equal(isSaveLocked(later, until + 1_000), false);
  assert.equal(later.saveUnknown, true);

  const direct = restoredCard(stored([pendingCard({ requestId: null, saveLockedUntil: until })], now), now + 5_000);
  assert.equal(direct.status, "error", "a proposal with no stored request is never saved a second time");
  assert.equal(direct.saveUnknown, true);
  assert.equal(direct.resultText, RELOAD_DURING_DIRECT_SAVE_TEXT);

  const unknownBefore = restoredCard(stored([pendingCard({ saveLockedUntil: until, saveUnknown: true, saveError: "Сервер хариу өгсөнгүй — …" })], now), now + 5_000);
  assert.equal(unknownBefore.saveError, "Сервер хариу өгсөнгүй — …", "an outcome already known to be unknown keeps its words");
  assert.equal(unknownBefore.saveLockedUntil, until);

  const saved = restoredCard(stored([pendingCard({ status: "applied", saveLockedUntil: until })], now), now + 5_000);
  assert.ok(saved.status === "applied" && saved.saveLockedUntil === undefined && !saved.saveUnknown, "a finished card loses a stray lock");
  const plainPending = restoredCard(stored([pendingCard()], now), now + 5_000);
  assert.ok(!plainPending.saveUnknown && !plainPending.saveLockedUntil, "a card that was not saving is untouched");
});

test("a lock is ended only by its own timer; a newer save keeps its own lock", () => {
  const thread: AssistantChatMessage[] = [pendingCard({ saveLockedUntil: 2_000 })];
  assert.equal((unlockSave(thread, "p1", 2_000)[0] as AssistantProposalMsg).saveLockedUntil, undefined);
  assert.equal((unlockSave(thread, "p1", 1_000)[0] as AssistantProposalMsg).saveLockedUntil, 2_000, "an older timer leaves a newer lock alone");
  assert.equal(isSaveLocked({ saveLockedUntil: 2_000 }, 1_999), true);
  assert.equal(isSaveLocked({ saveLockedUntil: 2_000 }, 2_000), false, "a stale lock never keeps Save off");
  assert.equal(isSaveLocked({}, 0), false);
});

test("save: a long save is waited for past the route's limit, and every answer reads plainly", () => {
  assert.ok(APPLY_WAIT_MS > 180_000, "the client waits longer than the route's 180 s maxDuration");
  assert.equal(applyOutcome(200, { ok: true, results: ["«A»: 12/2: Дүүрсэн"] }).kind, "saved");
  assert.deepEqual(applyOutcome(200, { ok: true, message: "Request already applied.", results: [] }), { kind: "saved", text: "Өмнө нь хадгалагдсан байна.", links: [] });
  const expired = applyOutcome(409, { ok: false, error: "proposal_expired", message: "Энэ санал 24 цагаас хуучирсан тул хадгалахгүй. Зааврыг дахин илгээнэ үү." });
  assert.equal(expired.kind, "expired");
  assert.match(expired.text, /24 цагаас хуучирсан/);
  assert.equal(applyOutcome(null, {}).kind, "unknown", "no answer is not a failure");
  assert.equal(applyOutcome(504, {}).kind, "unknown", "a gateway timeout is not a failure either");
  assert.match(applyOutcome(null, {}, { stored: false }).text, /Давхар хадгалахгүй/, "an unsaved proposal is never saved twice blindly");
  assert.equal(applyOutcome(409, { ok: false, retry: true, results: ["Үнэ дутуу"] }).kind, "retry");
  assert.deepEqual(applyOutcome(409, { ok: false, results: ["«A» өөрчлөгдсөн байна"] }), { kind: "failed", text: "«A» өөрчлөгдсөн байна" });
});

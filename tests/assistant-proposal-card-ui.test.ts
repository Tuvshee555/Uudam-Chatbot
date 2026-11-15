/**
 * The assistant's proposal card and thread as the admin sees them (server-rendered markup):
 * every new action type in plain Mongolian, photo before/after thumbnails, warnings said
 * plainly, questions as buttons with no actions (B5), the expired and "simple mode" states.
 * Trips, prices and photos are the invented fixture (tests/helpers/changeActionFixture.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantTab } from "../src/components/admin/AssistantTab";
import { proposalMessage } from "../src/components/admin/assistantChatLogic";
import type { AssistantChatMessage, AssistantProposalMsg } from "../src/components/admin/assistantChatTypes";
import { buildProposalClarifications } from "../src/lib/adminProposalUtils";
import type { AIProposal, TravelTrip } from "../src/lib/adminTypes";
import { P1, P2, P4, VERSION, fixtureTrip } from "./helpers/changeActionFixture";

const noop = () => undefined;
const TRIP = "trip-velmor";
const NAME = "ВЭЛМОР НУУРЫН АЯЛАЛ";

function render(messages: AssistantChatMessage[], options: { trips?: TravelTrip[]; tripDetails?: Record<string, TravelTrip>; busy?: boolean; busyStages?: Array<{ at: number; label: string }> } = {}) {
  return renderToStaticMarkup(createElement(AssistantTab, {
    messages, existingTrips: options.trips ?? [fixtureTrip() as unknown as TravelTrip], tripDetails: options.tripDetails,
    aiInput: "", setAiInput: noop, attachedFiles: [], onRemoveAttachedFile: noop, dragOver: false, setDragOver: noop,
    busy: options.busy ?? false, busyLabel: "", busyProgress: null, busyStages: options.busyStages ?? null, applyBusyId: "", clarifyBusyId: "",
    onSend: noop, onChooseOption: noop, onQuickAction: noop, onEditTripPrice: noop, onNewTrip: noop, onApply: noop, onRollback: noop,
    onSubmitClarificationForm: noop, onCancelProposal: noop, onResendInstruction: noop, onNewConversation: noop,
    onPickFile: noop, onDropFiles: noop, chatEndRef: createRef<HTMLDivElement>(), inputRef: createRef<HTMLTextAreaElement>(),
  }));
}

const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

function multiProposal(): AIProposal {
  const base = { trip_id: TRIP, expected_updated_at: VERSION };
  return {
    summary: "Таны 5 өөрчлөлт.",
    needs_confirmation: true,
    important_reason: "",
    actions: [
      { ...base, action: "set_date_price", date: "2099-02-10", adult: { delta: 100_000 }, summary: `«${NAME}» — 2/10: Том хүн 2,590,000₮ → 2,690,000₮; Бусад 1 огнооны үнэ хэвээр үлдэнэ.` },
      { ...base, action: "replace_photo", position: 2, new_url: P4, summary: `«${NAME}» — 2-р зураг солигдоно; Зургийн тоо: 3 → 3` },
      { ...base, action: "set_visibility", visible: false, summary: `«${NAME}» — Сайт, ботоос нууна (бичлэг, үнэ, зураг хадгалагдана)` },
      { ...base, action: "patch_itinerary_day", day: 3, title: "Чөлөөт өдөр", summary: `«${NAME}» — 3-р өдөр: гарчиг «Вэлмор — Улаанбаатар» → «Чөлөөт өдөр»` },
      { ...base, action: "set_age_bands", child: "2-12 нас", summary: `«${NAME}» — Хүүхэд: 2-11 нас → 2-12 нас` },
    ] as unknown as AIProposal["actions"],
    conflicts: [],
    conflict_items: [
      { text: `«${NAME}»: Хүүхдийн үнэ том хүнийхээс өндөр болно.`, severity: "warning", type: "plan_warning" },
      { text: `«${NAME}»: 2/17 вэбсайтад алга тул төлвийг нь өөрчлөхгүй.`, severity: "warning", type: "agent_refused" },
      { text: "«ӨВЛИЙН ВЭЛМОР» алгасагдсан: хамтрагчийн сайтаас 30 минут тутам шинэчлэгддэг", severity: "warning", type: "fare_change_skipped", data: { trip_id: "trip-partner" } },
      { text: `«${NAME}»: нярайн үнэгүй тариф хэвээр`, severity: "info", type: "fare_note" },
    ],
  };
}

const card = (proposal: AIProposal, over: Partial<AssistantProposalMsg> = {}): AssistantProposalMsg =>
  ({ ...proposalMessage(proposal, 41, { id: "p1", sent: "…" }), ...over });

test("one card, five kinds of change on one trip: each in plain Mongolian, the photo as before → after", () => {
  const text = plain(render([{ id: "m1", role: "admin", text: "вэлмор 2/10 +100k, 2-р зургийг соль, нуу, 3-р өдөр чөлөөт, хүүхэд 2-12" }, card(multiProposal())]));
  assert.ok(text.includes(NAME), "the trip is the card's title");
  assert.ok(text.includes("5 ӨӨРЧЛӨЛТ"));
  assert.match(text, /2\/10 насанд хүрэгч 2,590,000₮ → болно 2,690,000₮/u, "date + passenger, before → after (read live from the trip)");
  assert.ok(text.includes("Бусад 1 огнооны үнэ хэвээр үлдэнэ."));
  assert.ok(text.includes("Сайтаас нуух") && text.includes("Сайт, ботоос нууна"), "hide is said as hide, not archive");
  assert.ok(text.includes("3-р өдөр") && text.includes("Чөлөөт өдөр"));
  assert.ok(text.includes("Хүүхэд") && text.includes("2-12 нас"), "the age band");
  assert.ok(text.includes("Хадгалах"));
  const html = render([card(multiProposal())]);
  assert.ok(html.includes("velmor-forest.jpg") && html.includes("velmor-sunrise.jpg"), "both thumbnails: the photo now (position 2) and the new one");
  assert.ok(html.includes("c_fill,w_320,h_240"), "thumbnails are small Cloudinary renditions");
  assert.equal(html.includes("trip-velmor"), false, "never an id on screen");
});

test("warnings are said plainly: refused parts, plan warnings, skipped trips of a fare rule, fare notes", () => {
  const text = plain(render([card(multiProposal())]));
  assert.ok(text.includes("Анхаарах · 2"));
  assert.ok(text.includes("Хүүхдийн үнэ том хүнийхээс өндөр болно."), "plan_warning, without repeating the trip name");
  assert.ok(text.includes("2/17 вэбсайтад алга"), "agent_refused");
  assert.ok(text.includes("Алгассан аялал · 1") && text.includes("«ӨВЛИЙН ВЭЛМОР» алгасагдсан"), "fare_change_skipped listed");
  assert.ok(text.includes("ярайн үнэгүй тариф хэвээр"), "fare_note shown, not hidden behind a toggle");
  assert.equal(text.includes("Бүгдийг харах"), false);
});

test("a saved card keeps the lines it proposed; it never re-reads them as 'already so'", () => {
  const hidden = fixtureTrip({}, { customer_visible: false }) as unknown as TravelTrip;
  const text = plain(render([card(multiProposal(), { status: "applied", resultText: "Хадгалагдлаа." })], { trips: [hidden] }));
  assert.ok(text.includes("Сайт, ботоос нууна"));
  assert.equal(text.includes("Аль хэдийн нуусан"), false);
  assert.ok(text.includes("Буцаах"), "undo is offered");
});

test("a list row has no program text: the card says the server's line, and reads the full trip once it is loaded", () => {
  const projection = fixtureTrip({}, { list_projection: true, itinerary_days: [{}, {}, {}] }) as unknown as TravelTrip;
  const dayPhoto: AIProposal = { ...multiProposal(), conflict_items: [], actions: [
    { action: "replace_photo", trip_id: TRIP, expected_updated_at: VERSION, day: 1, new_url: P4, summary: `«${NAME}» — 1-р өдрийн зураг солигдоно; Зургийн тоо: 3 → 3` },
  ] as unknown as AIProposal["actions"] };
  const listOnly = render([card(dayPhoto)], { trips: [projection] });
  assert.ok(plain(listOnly).includes("1-р өдрийн зураг солигдоно"));
  assert.ok(listOnly.includes("velmor-sunrise.jpg"), "the new photo is shown");
  assert.equal(listOnly.includes("velmor-lake.jpg"), false, "the old day photo is unknown from a list row");
  const full = render([card(dayPhoto)], { trips: [projection], tripDetails: { [TRIP]: fixtureTrip() as unknown as TravelTrip } });
  assert.ok(full.includes(P1.split("/").pop() as string), "with the full trip the day's current photo is the 'before'");
});

test("a question with no actions is a set of buttons; a tap answers it (B5)", () => {
  const proposal: AIProposal = {
    summary: "", needs_confirmation: true, important_reason: "", conflicts: [], actions: [],
    questions: [{ id: "agent", prompt: "Аль өдрийн үнийг нэмэх вэ?", allow_custom: true, options: [
      { label: "2/10", answer: `«${NAME}» 2/10-ны үнийг 100 мянгаар нэм [сонгосон аялал: «${NAME}» id:${TRIP}]` },
      { label: "2/24", answer: `«${NAME}» 2/24-ны үнийг 100 мянгаар нэм [сонгосон аялал: «${NAME}» id:${TRIP}]` },
    ] }],
  };
  const html = render([card(proposal)]);
  const text = plain(html);
  assert.ok(text.includes("Аль өдрийн үнийг нэмэх вэ?"));
  assert.ok(text.includes("2/10") && text.includes("2/24"));
  assert.equal(html.includes('type="radio"'), false, "buttons, not a form to fill in");
  assert.equal(html.includes("сонгосон аялал"), false, "the answer's tag is never shown");
  assert.ok(text.includes("Хариулт хэрэгтэй"));
});

test("an 'agent' question asked again after an earlier answer is still shown", () => {
  const proposal: AIProposal = {
    summary: "", needs_confirmation: true, important_reason: "", conflicts: [], actions: [],
    questions: [{ id: "agent", prompt: "Аль зургийг солих вэ?", options: [{ label: "2-р зураг", answer: "2-р зураг" }] }],
  };
  assert.equal(buildProposalClarifications(proposal, ["agent"]).length, 1);
});

test("an expired proposal says so plainly and offers to send the instruction again", () => {
  const text = plain(render([card(multiProposal(), {
    status: "error", expired: true, resultText: "Энэ санал 24 цагаас хуучирсан тул хадгалахгүй — аяллын мэдээлэл тэр хооронд өөрчлөгдсөн байж магадгүй. Зааврыг дахин илгээнэ үү.",
  })]));
  assert.ok(text.includes("Хуучирсан"));
  assert.ok(text.includes("24 цагаас хуучирсан"));
  assert.ok(text.includes("Дахин илгээх"));
});

test("the thread: tags hidden in the admin's line, his photos as thumbnails, the 'simple mode' caption, the progress line", () => {
  const html = render([
    { id: "m1", role: "admin", text: `«${NAME}» 2/10 [сонгосон аялал: «${NAME}» id:${TRIP}]`, imageUrls: [P2] },
    { id: "n1", role: "assistant", kind: "note", tone: "info", text: "Энгийн горимоор уншлаа.", meta: { source: "brain", simple: true } },
    { id: "n2", role: "assistant", kind: "note", tone: "info", text: "2/10 дүүрсэн байна.", meta: { source: "agent", steps: ["search_trips", "get_trip", "reply"] } },
  ], { busy: true, busyStages: [{ at: 0, label: "Ойлгож байна…" }, { at: 2.5, label: "Аяллыг шалгаж байна…" }] });
  const text = plain(html);
  assert.equal(html.includes("сонгосон аялал"), false);
  assert.ok(html.includes("c_fill,w_160,h_120") && html.includes("velmor-forest.jpg"), "the photos he sent");
  assert.ok(text.includes("Энгийн горим — AI түр ажиллахгүй"));
  assert.ok(text.includes("AI туслах · аялал хайсан · аяллыг шалгасан"));
  assert.ok(text.includes("Ойлгож байна…"), "the progress line starts with its first step");
  assert.ok(text.includes("Шинэ яриа"), "a fresh conversation can be started");
});

test("a question that needs a typed answer invites it, and the composer says what to type", () => {
  const html = render([{ id: "a1", role: "assistant", kind: "ask", text: "Хэдэн төгрөгөөр нэмэх вэ?", options: [], allowCustom: true, customPlaceholder: "ж: 100,000",
    answerTo: { question: "Хэдэн төгрөгөөр нэмэх вэ?", instruction: "«Вэлмор» 2/10-ны үнийг нэм" } }]);
  assert.ok(plain(html).includes("Доор бичээрэй — ж: 100,000"));
  assert.ok(html.includes('placeholder="ж: 100,000"'));
});

const UNKNOWN = "Сервер хариу өгсөнгүй — өөрчлөлт хадгалагдсан эсэх тодорхойгүй. «Хадгалах»-ыг дахин дарвал хадгалагдсан эсэхийг шалгаад, хадгалагдаагүй бол хадгална.";
const newTrip = (): AIProposal => ({
  summary: "Шинэ аялал", needs_confirmation: true, important_reason: "", conflicts: [],
  actions: [{ action: "upsert", fields: { route_name: "ВЭЛМОР ХАВРЫН АЯЛАЛ", adult_price: 1_990_000, currency: "MNT", duration_text: "5 өдөр 4 шөнө", departure_dates: ["2099-03-01"] } }] as unknown as AIProposal["actions"],
});

test("a save with no answer is said as unknown, never as «Хадгалагдсангүй», and Save waits until the server has stopped", () => {
  const until = Date.now() + 120_000;
  const html = render([card(multiProposal(), { saveUnknown: true, saveError: UNKNOWN, saveLockedUntil: until })]);
  const text = plain(html);
  assert.equal(text.includes("Хадгалагдсангүй"), false, "the change may well have been saved");
  assert.ok(text.includes("хадгалагдсан эсэх тодорхойгүй"));
  assert.ok(text.includes("Тодорхойгүй"), "the tag says unknown");
  assert.equal(text.includes("Хадгалахад бэлэн"), false, "not 'ready to save'");
  assert.ok(text.includes("хүртэл идэвхгүй"), "says until when Save is off");
  assert.ok(text.includes("Хүлээж байна…"));
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Хүлээж байна…/u, "Save is off while the server may still be saving");

  const stale = plain(render([card(multiProposal(), { saveUnknown: true, saveError: UNKNOWN, saveLockedUntil: Date.now() - 1 })]));
  assert.equal(stale.includes("Хүлээж байна…"), false, "a lock in the past never keeps Save off");
  assert.equal(stale.includes("хүртэл идэвхгүй"), false);
  assert.ok(stale.includes("Тодорхойгүй"));

  const refused = plain(render([card(multiProposal(), { saveError: "Үнэ дутуу" })]));
  assert.ok(refused.includes("Хадгалагдсангүй: Үнэ дутуу"), "a refusal that saved nothing still says so");
  assert.equal(refused.includes("Тодорхойгүй"), false);
});

test("a new trip's review: an unknown save is amber with both buttons off; a refusal keeps «Хадгалагдсангүй»", () => {
  const until = Date.now() + 120_000;
  const html = render([card(newTrip(), { saveUnknown: true, saveError: UNKNOWN, saveLockedUntil: until })], { trips: [] });
  const text = plain(html);
  assert.equal(text.includes("Хадгалагдсангүй"), false);
  assert.ok(text.includes("хадгалагдсан эсэх тодорхойгүй") && text.includes("Тодорхойгүй"));
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Ноорог хадгалах/u);
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Нийтлэх/u);
  const refused = plain(render([card(newTrip(), { saveError: "Гарах өдөр дутуу" })], { trips: [] }));
  assert.ok(refused.includes("Хадгалагдсангүй: Гарах өдөр дутуу"));
});

test("an unsaved proposal whose save got no answer is closed as unknown, not as an error", () => {
  const text = plain(render([card(multiProposal(), {
    requestId: null, status: "error", saveUnknown: true,
    resultText: "Сервер хариу өгсөнгүй — өөрчлөлт хадгалагдсан эсэх тодорхойгүй. Давхар хадгалахгүйн тулд «Аяллууд» хэсгээс шалгаад, шаардлагатай бол зааврыг дахин илгээнэ үү.",
  })]));
  assert.ok(text.includes("Тодорхойгүй") && text.includes("Давхар хадгалахгүйн тулд"));
  assert.equal(text.includes("Алдаа"), false, "not tagged as a failure");
  assert.equal(/Хадгалах(?!\S)/u.test(text.replace(/«Хадгалах»/gu, "")), false, "no Save to press twice");
});

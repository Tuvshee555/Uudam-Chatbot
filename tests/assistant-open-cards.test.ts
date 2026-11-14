/**
 * A file reading never damages a saved trip, and a message about a trip still on an unsaved card
 * changes that card (2026-11-14: a split file renamed and emptied another trip; "сүүлийн өдрийг нэм"
 * and "… линк" went to saved trips while the new trip sat unsaved on its card). Invented trips only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { guardFileProposal, sourceFileBase } from "../src/lib/fileProposalGuards";
import { distinctiveTokens, sharedDistinctive } from "../src/lib/tripNameTokens";
import { soundAlikeTrips } from "../src/lib/assistantAgent/fuzzyTripSearch";
import { openProposalRoute, parseOpenProposals, type OpenProposal } from "../src/lib/assistantAgent/openProposals";
import { instructionBody, openNewTripProposals } from "../src/components/admin/assistantChatLogic";
import type { AssistantChatMessage } from "../src/components/admin/assistantChatTypes";
import type { AIChangeProposal, TravelTrip } from "../src/lib/travelTypes";

const trip = (id: string, route_name: string, extra: Record<string, unknown> = {}, departure_dates: string[] = ["2099-01-10"]): TravelTrip => ({
  id, route_name, status: "active", category: "Аялал", operator_name: "Туршилт", duration_text: "", adult_price: null, child_price: null, infant_price: null,
  currency: "MNT", departure_dates, seats_total: null, seats_left: null, has_food: null, notes: "", hotel: "", source_description: "",
  photo_urls: [], created_at: "", updated_at: "2099-01-01T00:00:00Z", extra,
} as unknown as TravelTrip);

const TRIPS = [
  trip("t-tavlin", "ТАВЛИН – ДАМЖИН НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ"),
  trip("t-velmor", "Велмор хотын 8 шөнө 9 өдрийн аялал", { price_groups: [{ label: "Том хүн" }] }),
];

test("trip names compare by their place words, not the words every name repeats", () => {
  assert.equal(sharedDistinctive("Шинэ жилийн Норвел хотын аялал", TRIPS[0].route_name), 0);
  assert.equal(sharedDistinctive("Велмор – Норвел хотын аялал", TRIPS[1].route_name), 1);
  assert.deepEqual(distinctiveTokens("шинэ жилийн хотын аяллын линк"), []);
});

test("sound-alike search ignores generic words", () => {
  assert.deepEqual(soundAlikeTrips("шинэ жилийн норвел хотын аялал", TRIPS).map((entry) => entry.trip.id), []);
  assert.equal(soundAlikeTrips("велмор", TRIPS)[0]?.trip.id, "t-velmor");
});

test("a split file's part names its file", () => {
  assert.equal(sourceFileBase("Аялал.docx.part-002-of-002.txt"), "Аялал.docx");
  assert.equal(sourceFileBase("Аялал.pdf.parsed-text-001-of-003.txt"), "Аялал.pdf");
  assert.equal(sourceFileBase("Аялал.pdf"), "Аялал.pdf");
});

const proposal = (actions: unknown[]): AIChangeProposal => ({ summary: "", actions, conflicts: [], conflict_items: [], needs_confirmation: true } as unknown as AIChangeProposal);

test("a part of a file that makes a new trip never changes another trip", () => {
  const p = proposal([
    { action: "upsert", fields: { route_name: "Норвел хотын аялал", extra: { source_file_name: "Норвел.docx.part-001-of-002.txt" } } },
    { action: "patch", trip_id: "t-velmor", fields: { notes: "x", extra: { source_file_name: "Норвел.docx.part-002-of-002.txt" } } },
  ]);
  guardFileProposal(p, TRIPS);
  assert.equal(p.actions.length, 1);
  assert.equal(p.actions[0].action, "upsert");
  assert.ok(p.conflict_items?.some((item) => item.type === "file_change_removed"));
});

test("a file reading never renames a saved trip or empties its dates and price rows", () => {
  const p = proposal([
    { action: "patch", trip_id: "t-velmor", fields: { route_name: "Шинэ нэр", departure_dates: [], extra: { price_groups: [], departure_date_groups: [], tour_title: "Шинэ нэр" } } },
  ]);
  guardFileProposal(p, [trip("t-velmor", "Велмор хотын аялал", { price_groups: [{ label: "Том хүн" }], departure_date_groups: [{ label: "A" }] })]);
  assert.equal(p.actions.length, 0, "nothing left to change → no change at all");
  assert.equal((p.conflict_items || []).length, 3);
  const q = proposal([{ action: "patch", trip_id: "t-velmor", fields: { route_name: "Шинэ нэр", notes: "Тэмдэглэл" } }]);
  guardFileProposal(q, TRIPS);
  assert.equal(q.actions.length, 1);
  assert.equal((q.actions[0].fields as Record<string, unknown>).route_name, undefined);
  assert.equal((q.actions[0].fields as Record<string, unknown>).notes, "Тэмдэглэл");
});

const CARD: OpenProposal = { request_id: 41, names: ["Шинэ жилийн Норвел хотын аялал"], latest: true };

test("a message naming the open card's trip changes that card", () => {
  assert.deepEqual(openProposalRoute("Норвел хотын аяллын 3-р өдрийг зас", [CARD], TRIPS), { kind: "revise", target: CARD, name: CARD.names[0] });
  assert.equal(openProposalRoute("шинэ жилийн норвел хотын аяллын линк", [CARD], TRIPS)?.kind, "link");
});

test("a change that names no trip goes to the card just shown", () => {
  assert.equal(openProposalRoute("сүүлийн өдрийг нэм", [CARD], TRIPS)?.kind, "revise");
  assert.equal(openProposalRoute("сүүлийн өдрийг нэм", [{ ...CARD, latest: false }], TRIPS), null, "not the last word: the agent decides");
  assert.equal(openProposalRoute("сайн уу", [CARD], TRIPS), null);
});

test("a saved trip named, a pasted link or another new trip is not the card", () => {
  assert.equal(openProposalRoute("Велмор аяллын үнийг 2 сая болго", [CARD], TRIPS), null);
  assert.equal(openProposalRoute("энийг нэм https://example.com/trip/1", [CARD], TRIPS), null);
  assert.equal(openProposalRoute("шинэ аялал нэм", [CARD], TRIPS), null);
  assert.equal(openProposalRoute("сүүлийн өдрийг нэм", [], TRIPS), null);
});

test("the page's open_proposals are checked", () => {
  assert.deepEqual(parseOpenProposals([
    { request_id: 7, names: ["Норвел", 3, ""], latest: true },
    { request_id: "8", names: ["x"] },
    { request_id: 9, names: [] },
    null,
  ]), [{ request_id: 7, names: ["Норвел"], latest: true }]);
  assert.deepEqual(parseOpenProposals("nope"), []);
  assert.equal(parseOpenProposals(Array.from({ length: 5 }, (_, i) => ({ request_id: i + 1, names: ["a"] }))).length, 3);
});

const card = (id: string, requestId: number, status: string, actions: unknown[], extra: Record<string, unknown> = {}) => ({
  id, role: "assistant", kind: "proposal", requestId, status, proposal: { summary: "", actions, conflicts: [] }, ...extra,
}) as unknown as AssistantChatMessage;

test("the page sends only its open new-trip cards, newest first", () => {
  const messages = [
    card("c1", 1, "pending", [{ action: "upsert", fields: { route_name: "Норвел" } }]),
    card("c2", 2, "applied", [{ action: "upsert", fields: { route_name: "Велмор" } }]),
    card("c3", 3, "pending", [{ action: "patch", trip_id: "t-velmor", fields: {} }]),
    card("c4", 4, "pending", [{ action: "upsert", fields: { route_name: "Тавлин" } }], { expired: true }),
    { id: "u1", role: "user", text: "сүүлийн өдрийг нэм" } as unknown as AssistantChatMessage,
    card("c5", 5, "pending", [{ action: "upsert", fields: { route_name: "Сарнай" } }]),
  ];
  assert.deepEqual(openNewTripProposals(messages), [
    { request_id: 5, names: ["Сарнай"], latest: true },
    { request_id: 1, names: ["Норвел"], latest: false },
  ]);
  const body = instructionBody({ instruction: "x", sessionId: "s", openProposals: openNewTripProposals(messages) });
  assert.equal((body.open_proposals as unknown[]).length, 2);
  assert.equal("open_proposals" in instructionBody({ instruction: "x", sessionId: "s" }), false);
});

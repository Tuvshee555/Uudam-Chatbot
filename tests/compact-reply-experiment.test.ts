import assert from "node:assert/strict";
import test from "node:test";
import { presentAssistantReply, replyPreferences } from "../src/lib/chatbotReplyPolicy";
import { buildTripAnswerPlan } from "../src/lib/tripAnswerPlan";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import { optionChosenByNumber } from "../src/lib/selectionAnswer";
import type { TravelTrip } from "../src/lib/travelTypes";
import { applyTestEnv } from "./helpers/env";

const now = new Date("2098-02-01T04:00:00Z");
const trip: TravelTrip = {
  id: "compact-velmor", route_name: "ВЭЛМОР НУУРЫН АЯЛАЛ", category: "Invented", operator_name: "Fixture",
  duration_text: "5 өдөр 4 шөнө", adult_price: 901_001, child_price: 401_001, infant_price: 101_001,
  currency: "MNT", departure_dates: ["2098-03-08"], seats_total: null, seats_left: null,
  has_food: true, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
  extra: {}, created_at: "", updated_at: "",
};
const route = { matchText: "", scopedClarify: null, chosenTripId: trip.id };

test("short answers remove padding and extra questions without losing the answer or signed URL", () => {
  const reply = presentAssistantReply({ userText: "үнэ", hasPriorReply: true, phoneAlreadyRequested: true,
    reply: "Сайн байна уу!\nБи танд туслахад бэлэн байна.\nТом хүн: 901,001₮. Зөвхөн хоёр хүн нэг өрөөнд.\nНэр, утасны дугаараа бичнэ үү.\nХэзээ явах вэ? Хэдүүлээ явах вэ?\nhttps://example.invalid/Offer_A?signature=X_Y\nӨөр мэдээлэл хэрэгтэй юу?" });
  assert.match(reply, /901,001₮\. Зөвхөн хоёр хүн нэг өрөөнд\./);
  assert.match(reply, /Хэзээ явах вэ\?/);
  assert.doesNotMatch(reply, /Сайн байна|туслахад|дугаараа|Хэдүүлээ|Өөр мэдээлэл|\n\n/);
  assert.match(reply, /https:\/\/example.invalid\/Offer_A\?signature=X_Y/);
  assert.equal(presentAssistantReply({ userText: "үнэ", hasPriorReply: true, phoneAlreadyRequested: true, reply }), reply);
});

test("a customer mentioning an earlier phone conversation gets one clarification", () => {
  const reply = presentAssistantReply({ userText: "Утсаар ярьсан хүн байна",
    reply: "Сайн байна уу! Та утсаар ярьсан аяллынхаа талаар дэлгэрэнгүй мэдээлэл авахыг хүсэж байна уу? Та аль аяллыг сонирхож байгаа вэ?" });
  assert.equal((reply.match(/\?/g) || []).length, 1);
  assert.match(reply, /аль аяллыг/);
  assert.equal(presentAssistantReply({ userText: "hi", reply: "Сайн байна уу!" }), "Сайн уу!");
});

test("padding cleanup preserves hotel names and conditions that mention contact", () => {
  for (const reply of ["Highland Lodge: өглөөний хоол багтсан.", "Утасны дугаараа бичвэл хүүхэд 401,001₮."]) {
    assert.equal(presentAssistantReply({ userText: "үнэ", reply }), reply);
  }
  assert.equal(presentAssistantReply({ userText: "үнэ", reply: "Нэр, утасны дугаараа бичнэ үү — төлбөр буцаахгүй." }), "төлбөр буцаахгүй.");
  assert.equal(replyPreferences("хөтөлбөрийг өдөр бүр явуул").full, true);
});

test("every-day meals stay focused while a full itinerary remains available", () => {
  const t = { ...trip, extra: { included_items: ["Зөвхөн өглөөний хоол", "Онгоцны тийз"], excluded_items: ["Өдрийн хоол", "Хувийн зардал"],
    itinerary_days: [{ day: 1, title: "Луми цэцэрлэг" }, { day: 2, title: "Пэлн нуур" }] } };
  assert.equal(replyPreferences("өдөр бүр хоол багтсан уу").full, false);
  const meal = buildTripAnswerPlan({ text: "өдөр бүр хоол багтсан уу", trips: [t], route, now })!;
  assert.equal(meal.status, "answered");
  assert.match(meal.reply, /Зөвхөн өглөөний хоол/);
  assert.match(meal.reply, /Өдрийн хоол/);
  assert.doesNotMatch(meal.reply, /Онгоцны тийз|Хувийн зардал|ВЭЛМОР/);
  const full = buildTripAnswerPlan({ text: "өдөр бүрийн бүтэн хөтөлбөр", trips: [t], route, now })!;
  assert.match(full.reply, /1-р өдөр: Луми цэцэрлэг[\s\S]*2-р өдөр: Пэлн нуур/);
});

test("a simple fare answer omits the marketing title and unrelated infant fare", () => {
  const plan = buildTripAnswerPlan({ text: "үнэ хэд вэ", trips: [trip], route, now })!;
  assert.equal(plan.status, "answered");
  assert.match(plan.reply, /Том хүн: 901,001₮/);
  assert.match(plan.reply, /Хүүхэд: 401,001₮/);
  assert.doesNotMatch(plan.reply, /Нярай|ВЭЛМОР|\n\n/);
  assert.equal(verifyTripReply({ reply: plan.reply, trips: [trip], selection: plan.selection, now }), plan.reply);
});

test("hotel clarification includes useful unit fares without inventing a party total", () => {
  const t = { ...trip, extra: { price_groups: [
    { dates: trip.departure_dates, hotel: "Lumen Lodge", adult_price: 901_001, child_price: 401_001 },
    { dates: trip.departure_dates, hotel: "Sable Lodge", adult_price: 1_001_001, child_price: 501_001 },
  ] } };
  const plan = buildTripAnswerPlan({ text: "3 сарын 8 2 том хүн нийт хэд вэ", trips: [t], route, now })!;
  assert.equal(plan.status, "clarify");
  assert.match(plan.reply, /Lumen Lodge\nТом хүн: 901,001₮/);
  assert.match(plan.reply, /Sable Lodge\nТом хүн: 1,001,001₮/);
  assert.doesNotMatch(plan.reply, /Нийт:/);
  assert.equal(optionChosenByNumber([{ role: "assistant", text: plan.reply }], "2"), "Sable Lodge");
  assert.equal(verifyTripReply({ reply: plan.reply, trips: [t], selection: plan.selection, now }), plan.reply);
});

test("the model prompt makes concise answers authoritative and removes contact pressure", async () => {
  applyTestEnv();
  const { buildPromptParts } = await import("../src/lib/conversation");
  const prompt = buildPromptParts({ systemPrompt: "Fixture assistant", business: {}, history: [], userText: "бодож үзье" }).system;
  assert.match(prompt, /about 10 words/);
  assert.match(prompt, /answer and stop/);
  assert.match(prompt, /Do not request their phone/);
  assert.doesNotMatch(prompt, /утасны дугаар асуу|Хэдүүлээ, хүүхэдтэй юу/);
});

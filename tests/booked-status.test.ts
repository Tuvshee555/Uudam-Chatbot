import assert from "node:assert/strict";
import test from "node:test";
import { bookedStatusTurn, isBookingStatusQuestion } from "../src/lib/bookedFollowup";
import type { TravelLead } from "../src/lib/travelTypes";

const lead = (fields: Partial<TravelLead> = {}) => ({
  id: 1, kind: "booking", platform: "facebook", sender_id: "fixture-customer", customer_message: "захиалга", contact_phone: "",
  context: "", status: "new", lead_status: "new_lead", created_at: "2098-02-09T04:00:00Z", seen_at: null, ...fields,
}) as TravelLead;

test("a waiting customer's status question gets the lead's status once, then 'nothing new', never spam", () => {
  for (const text of ["Хэзээ холбогдох вэ?", "Над руу залгах уу?", "Захиалга маань юу болсон бэ?", "hezee holbogdoh ve", "zahialga maani yu bolson be"]) {
    assert.ok(isBookingStatusQuestion(text), text);
  }
  for (const text of ["Хүүхдийн үнэ хэд вэ?", "Сайн байна уу", "Захиалга өгье", "Хэзээ гарах вэ?"]) assert.ok(!isBookingStatusQuestion(text), text);
  const booking = lead({ contact_phone: "90001234", context: "Хүссэн аялал: ФИКСТУР АЯЛАЛ" });
  const full = bookedStatusTurn(booking, {}, "Хэзээ холбогдох вэ?")!;
  assert.match(full, /^Таны захиалгын хүсэлт бүртгэгдсэн\.\nАялал: ФИКСТУР АЯЛАЛ\nХолбогдох утас: ••••1234\n/);
  const short = bookedStatusTurn(booking, { reply: full, question: "Хэзээ холбогдох вэ?" }, "Над руу залгах уу?");
  assert.match(short ?? "", /^Шинэ мэдээлэл алга:/);
  assert.equal(bookedStatusTurn(booking, { reply: short!, question: "Над руу залгах уу?" }, "над руу залгах уу?"), null, "the same question again");
  // A request is never called confirmed; only a consultant's "booked" mark is quoted, as theirs.
  assert.doesNotMatch(full, /баталгаажсан/);
  assert.match(bookedStatusTurn({ ...booking, lead_status: "booked" }, {}, "Захиалга маань юу болсон бэ?")!, /бүртгэлд «захиалсан» гэж тэмдэглэсэн/);
});

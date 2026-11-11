import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { asksClockTime, scheduleTimeSection } from "../src/lib/scheduleTimes";
import { conversationGateHarness, type ModelOverride as BaseOverride } from "./helpers/conversationGateHarness";
import { closedDepartureCatalog } from "./helpers/understandingRoutingCatalogs";
import { textOf } from "./helpers/understandingRoutingFixtures";

type ModelOverride = BaseOverride & { trips?: string[]; requestedFacts?: Array<{ field: string; evidence: string }> };
type Harness = Awaited<ReturnType<typeof conversationGateHarness>>;
const one = (tripId: string, extra: ModelOverride = {}): ModelOverride => ({ certainty: "one", tripId, ...extra });

/**
 * Case 16: a traveller a consultant is already working with asks about "her" date and the flight
 * time. The date is a CLOSED, archived departure; the bot said "no trip then" and listed other dates,
 * and answered the flight-time question with a category label. Now: a closed departure is called
 * closed (a data fact); a customer a consultant wrote to within 30 days is sold no alternatives
 * (silence plus a typed lead); a clock time is answered only from the itinerary. Invented data.
 */
const NO_TRIP_THEN = "Тэр хугацаанд гарах аялал алга";

/** A consultant's reply in the thread, `daysAgo` days before the mocked now (stored as role 'staff'). */
function staffReplied(harness: Harness, senderId: string, daysAgo: number) {
  harness.history.push({ id: (harness.history.at(-1)?.id || 0) + 1, sender_id: senderId, role: "staff", text: "Бүлгийн линкийг илгээлээ.",
    attachments: [], created_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString() });
}

test("a date that matches a closed departure is called closed, not 'no trip then' with other dates", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(closedDepartureCatalog);
  try {
    for (const [index, text] of ["11.3 nii verdan", "11 сарын 3-ны вердан", "вердан 11/3 ны аялал", "Вердан 11.3"].entries()) {
      const result = await harness.turn(`rt-c16-closed-${index}`, text, {});
      const said = textOf(result.sends);
      assert.ok(said.includes("ВЕРДАН - ПАРКЛЭНД"), `"${text}": names the departure that exists: ${said}`);
      assert.match(said, /дүүрсэн|авах боломжгүй/, `"${text}": says it is closed: ${said}`);
      assert.ok(!said.includes(NO_TRIP_THEN), `"${text}": a departure that exists is not 'no trip then': ${said}`);
      assert.ok(!said.includes("11 сарын 12"), `"${text}": no other dates sold to a customer asking about a closed one: ${said}`);
      assert.ok(result.leads.length > 0, `"${text}": staff get the lead`);
    }
    // Positive controls: a date with no departure at all, anywhere, is still answered with the real dates.
    const nothing = await harness.turn("rt-c16-none", "11.9 nii verdan", {});
    assert.ok(textOf(nothing.sends).includes(NO_TRIP_THEN), `a date no departure ever had keeps the dates reply: ${textOf(nothing.sends)}`);
    assert.ok(textOf(nothing.sends).includes("11 сарын 12"));
    // A date that IS bookable is answered normally.
    const open = await harness.turn("rt-c16-open", "11.12 nii verdan", {});
    assert.ok(!textOf(open.sends).includes(NO_TRIP_THEN) && !/дүүрсэн/.test(textOf(open.sends)), `an open date is not called closed: ${textOf(open.sends)}`);
  } finally {
    await harness.close();
  }
});

test("a customer a consultant wrote to within 30 days is sold no alternatives (silence plus a typed lead)", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(closedDepartureCatalog);
  try {
    for (const [index, text] of ["11.3 nii verdan", "11.9 nii verdan", "11 сарын 3-ны вердан", "вердан 12.30"].entries()) {
      const sender = `rt-c16-existing-${index}`;
      staffReplied(harness, sender, 5);
      const result = await harness.turn(sender, text, {});
      assert.deepEqual(result.sends, [], `"${text}": an existing customer is not sold other dates: ${textOf(result.sends)}`);
      assert.ok(result.leads.some((lead) => /Зөвлөхтэй өмнө нь харилцсан/.test(lead.context)), `"${text}": staff get a lead that says why: ${result.leads.map((l) => l.context).join("|")}`);
    }
    // 31+ days: a prospect again.
    const old = "rt-c16-old";
    staffReplied(harness, old, 45);
    const prospect = await harness.turn(old, "11.9 nii verdan", {});
    assert.ok(textOf(prospect.sends).includes(NO_TRIP_THEN), `an old consultant message does not make an existing customer: ${textOf(prospect.sends)}`);
    // An exact data fact about a trip the customer names is still answered.
    const fact = "rt-c16-fact";
    staffReplied(harness, fact, 5);
    const priced = await harness.turn(fact, "УБ-Вердан хотын 11-р сарын аяллын хөтөлбөр үнэ хэд вэ", one("nov", { topics: ["price"] }));
    assert.ok(textOf(priced.sends).includes("2,990,000"), `a named trip's fare is a data fact: ${textOf(priced.sends)}`);
  } finally {
    await harness.close();
  }
});

test("a clock time is answered from the itinerary, never from a transport label", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(closedDepartureCatalog);
  try {
    const readings: Array<[string, ModelOverride]> = [
      ["dates and transport", { topics: ["dates", "transport"] }], ["transport", { topics: ["transport"] }],
      ["program", { topics: ["program"] }], ["nothing", { topics: [] }],
    ];
    for (const text of ["Heden tsagt niseh ve", "Нислэг хэдэн цагт вэ", "Буцах нислэг хэдэн цагт вэ", "Онгоц хэдэн цагт хөөрөх вэ", "Хэдэн цагт ниснэ", "Хэдэн цагийн нислэг вэ"]) {
      for (const [label, model] of readings) {
        const sender = `rt-c16-time-${text}-${label}`;
        await harness.turn(sender, "УБ-Вердан хотын 11-р сарын аяллын хөтөлбөр", one("nov", { topics: ["price"] }));
        const result = await harness.turn(sender, text, model);
        const said = textOf(result.sends);
        assert.ok(said.includes("13:00") && said.includes("16:45"), `"${text}" (${label}) is answered with the itinerary's clock times: ${said}`);
        assert.ok(!said.includes("Шууд нислэгтэй аялал."), `"${text}" (${label}): a category label is not an answer to a time question: ${said}`);
      }
    }
    // The itinerary holds no clock time: silence plus a lead, whatever the reading.
    for (const [label, model] of readings) {
      const sender = `rt-c16-notime-${label}`;
      await harness.turn(sender, "УБ-Мирель хотын аяллын хөтөлбөр", one("plain", { topics: ["price"] }));
      const result = await harness.turn(sender, "Нислэг хэдэн цагт вэ", model);
      assert.deepEqual(result.sends, [], `(${label}) no time in the data, no answer: ${textOf(result.sends)}`);
      assert.ok(result.leads.length > 0, `(${label}) staff get the lead`);
    }
    // Positive controls: a question that is not about a clock time keeps its ordinary answer.
    const sender = "rt-c16-label";
    await harness.turn(sender, "УБ-Вердан хотын 11-р сарын аяллын хөтөлбөр", one("nov", { topics: ["price"] }));
    const label = await harness.turn(sender, "Энэ аялал нислэгтэй юу", { topics: ["transport"] });
    assert.ok(textOf(label.sends).includes("Шууд нислэгтэй аялал."), `a kind-of-transport question is answered by the kind: ${textOf(label.sends)}`);
  } finally {
    await harness.close();
  }
});

test("clock-time detection: a leg's time, not a meeting place or an unrelated hour", () => {
  for (const text of ["Heden tsagt niseh ve", "Нислэг хэдэн цагт вэ", "Онгоц хэдэн цагт хөөрөх вэ", "Галт тэрэг хэдэн цагт хөдлөх вэ", "Автобус хэдэн цагт эхлэх вэ", "Хэдэн цагийн нислэг вэ"]) {
    assert.equal(asksClockTime(text), true, text);
  }
  for (const text of ["Онгоцны буудалд хэдэн цагт очих вэ", "Хэдэн цагт хоол идэх вэ", "Энэ аялал нислэгтэй юу", "Үнэ хэд вэ", "Хэдэн хоногийн аялал вэ"]) {
    assert.equal(asksClockTime(text), false, text);
  }
  const trip = closedDepartureCatalog[1];
  assert.match(scheduleTimeSection(trip, "Нислэг хэдэн цагт вэ") || "", /1-р өдөр:.*13:00.*16:45/);
  assert.match(scheduleTimeSection(trip, "Нислэг хэдэн цагт вэ") || "", /5-р өдөр:.*07:50.*12:00/);
  assert.equal(scheduleTimeSection(closedDepartureCatalog[4], "Нислэг хэдэн цагт вэ"), null);
});

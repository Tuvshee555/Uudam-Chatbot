/**
 * "Энэ мэдээллийг аяллын тайлбарт нэм" (src/lib/tripNotesAppend.ts, the append_notes action):
 * one named section is added to a trip's description and everything already there stays.
 * Invented trips, tests and prices only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { actionView } from "../src/lib/adminProposalUtils";
import type { AIAction } from "../src/lib/adminTypes";
import type { AITripAction } from "../src/lib/travelTypes";
import { planTripEdit, sanitizeTripEditAction } from "../src/lib/tripActionPlan";
import { numbersNotInSources, planAppendNotes } from "../src/lib/tripNotesAppend";
import { NOW, trip } from "./helpers/agentFixtures";

const HEADING = "Нэмэлт шинжилгээ – хүсвэл нэмж хийх зүйлс (төлбөртэй, юаниар)";
const INCLUDED = ["Аяллын ерөнхий тайлбар.", "", "Эрэгтэйчүүдийн шинжилгээ, үзлэгт хийх зүйлс", "Ерөнхий үзлэг:", "Даралт, өндөр, жин"].join("\n");
const CHECKUP = trip({ id: "t-check", route_name: "ТУРШИЛТ – ЭРҮҮЛ МЭНДИЙН АЯЛАЛ", notes: INCLUDED });

const planned = (target: typeof CHECKUP, heading: unknown, text: unknown) => {
  const result = planAppendNotes(target, { heading, text });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).plan;
};

test("a section is added under the description: bullets and bold marks dropped, everything already written kept", () => {
  const plan = planned(CHECKUP, `${HEADING}:`, "- Зүрх судас:\n- **Зүрхний ЭХО**: 180 юань\n\n\n• Жич: үнэ өөрчлөгдөж болно  ");
  assert.equal(plan.fields.notes, `${INCLUDED}\n\n${HEADING}\nЗүрх судас:\nЗүрхний ЭХО: 180 юань\n\nЖич: үнэ өөрчлөгдөж болно`);
  assert.deepEqual(plan.lines, [`Тайлбарт «${HEADING}» хэсэг нэмнэ (3 мөр); бусад тайлбар хэвээр`]);
  assert.deepEqual(Object.keys(plan.fields), ["notes"], "nothing but the description is written");

  const empty = planned(trip({ id: "t-empty", route_name: "ХООСОН ТАЙЛБАРТАЙ АЯЛАЛ" }), HEADING, "Зүрхний ЭХО: 180 юань");
  assert.equal(empty.fields.notes, `${HEADING}\nЗүрхний ЭХО: 180 юань`, "a trip with no description gets the section alone");
});

test("saved again under the same heading the section is replaced, not repeated; a later list and an identical section are left alone", () => {
  const later = "Эмэгтэйчүүдийн шинжилгээ, үзлэгт хийх зүйлс\nЕрөнхий үзлэг:\nДаралт";
  const first = planned(CHECKUP, HEADING, "Зүрхний ЭХО: 180 юань\nТолгойн MRI: 640 юань").fields.notes as string;
  const withLater = trip({ id: "t-check", route_name: CHECKUP.route_name, notes: `${first}\n\n${later}` });

  const again = planned(withLater, HEADING, "Зүрхний ЭХО: 190 юань");
  const notes = again.fields.notes as string;
  assert.equal(notes.split(HEADING).length - 1, 1, "one section under the heading");
  assert.match(notes, /Зүрхний ЭХО: 190 юань/);
  assert.doesNotMatch(notes, /180 юань|Толгойн MRI/, "the old lines of that section are gone");
  assert.ok(notes.startsWith(INCLUDED) && notes.endsWith(later), "the text before it and the list after it are untouched");
  assert.deepEqual(again.lines, [`Тайлбарын «${HEADING}» хэсгийг шинэчилнэ (1 мөр)`]);

  const same = planAppendNotes(trip({ id: "t-check", route_name: CHECKUP.route_name, notes: first }), { heading: HEADING, text: "Зүрхний ЭХО: 180 юань\nТолгойн MRI: 640 юань" });
  assert.deepEqual(same, { ok: false, reason: `«${HEADING}» хэсэг тайлбарт аль хэдийн ийм байна.` });
});

test("no heading, no lines or a description grown past its limit: refused with a plain reason", () => {
  assert.deepEqual(planAppendNotes(CHECKUP, { heading: " ", text: "Зүрхний ЭХО: 180 юань" }), { ok: false, reason: "Нэмэх хэсгийн гарчиг алга." });
  assert.deepEqual(planAppendNotes(CHECKUP, { heading: HEADING, text: " \n " }), { ok: false, reason: `«${HEADING}» хэсэгт нэмэх мөр алга.` });
  const long = trip({ id: "t-long", route_name: "УРТ ТАЙЛБАРТАЙ АЯЛАЛ", notes: "я".repeat(29_990) });
  const refused = planAppendNotes(long, { heading: HEADING, text: "Зүрхний ЭХО: 180 юань" });
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /Тайлбар хэт урт болно/);
});

test("every number of a section must stand in the admin's words or his file: a re-typed price is caught", () => {
  const sources = ["心脏彩超 | 180\n头部核磁 | 1,200\n甲功八项 | 480\nA项 175 335", "том хүн 1.590.000"];
  assert.deepEqual(numbersNotInSources("Зүрхний ЭХО: 180 юань\nТолгойн MRI: 1200 юань", sources), []);
  assert.deepEqual(numbersNotInSources("Бамбайн 8 үзүүлэлт: 480 юань", sources), [], "a single digit (a count) is not a price");
  assert.deepEqual(numbersNotInSources("А: 175 юань\nБ: 335 юань", sources), [], "two neighbouring numbers of the file are two numbers");
  assert.deepEqual(numbersNotInSources("Том хүн 1 590 000₮ (1,590,000)", sources), [], "thousands written with spaces, dots or commas are one number");
  assert.deepEqual(numbersNotInSources("Зүрхний ЭХО: 185 юань\nТолгойн MRI: 1200 юань\nШинэ: 185 юань", sources), ["185"], "a number no source holds, named once");
  assert.deepEqual(numbersNotInSources("Зүрхний ЭХО: 180 юань", []), ["180"], "no source, no number");
});

test("append_notes is planned and cleaned like every exact edit, and the card can show the lines it adds", () => {
  const raw = { action: "append_notes", trip_id: " t-check ", heading: `${HEADING}:`, text: "- Зүрхний ЭХО: 180 юань", fields: { notes: "x", status: "archived" }, expected_updated_at: "v1", summary: "s" };
  const clean = sanitizeTripEditAction(raw as unknown as AITripAction);
  assert.deepEqual(clean, { action: "append_notes", trip_id: "t-check", expected_updated_at: "v1", summary: "s", heading: HEADING, text: "Зүрхний ЭХО: 180 юань" }, "a model's stray fields never reach save");

  const outcome = planTripEdit(CHECKUP, clean, null, NOW);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.plan.fields.notes, `${INCLUDED}\n\n${HEADING}\nЗүрхний ЭХО: 180 юань`);

  const view = actionView(clean as unknown as AIAction, CHECKUP, { live: true, now: NOW });
  assert.deepEqual(view.lines, [`Тайлбарт «${HEADING}» хэсэг нэмнэ (1 мөр); бусад тайлбар хэвээр`]);
  assert.deepEqual(view.preview, { title: HEADING, lines: ["Зүрхний ЭХО: 180 юань"] }, "the admin reads the added lines before saving");
  const closed = actionView({ ...clean, summary: `«${CHECKUP.route_name}» — Тайлбарт «${HEADING}» хэсэг нэмнэ (1 мөр); бусад тайлбар хэвээр` } as unknown as AIAction, null, { live: false, now: NOW });
  assert.deepEqual(closed.preview, { title: HEADING, lines: ["Зүрхний ЭХО: 180 юань"] }, "a saved card keeps the lines too");
});

import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantTab } from "../src/components/admin/AssistantTab";
import type { AskMsg, ChatMessage, TravelTrip } from "../src/lib/adminTypes";

const noop = () => undefined;

function render(messages: ChatMessage[], existingTrips: TravelTrip[] = []) {
  return renderToStaticMarkup(createElement(AssistantTab, {
    messages, existingTrips, aiInput: "", setAiInput: noop, attachedFiles: [], onRemoveAttachedFile: noop, dragOver: false, setDragOver: noop,
    busy: false, busyLabel: "", busyProgress: null, applyBusyId: "", clarifyBusyId: "", onSend: noop, onChooseOption: noop, onQuickAction: noop,
    onEditTripPrice: noop, onNewTrip: noop, onApply: noop, onRollback: noop, onSubmitClarificationForm: noop, onCancelProposal: noop,
    onPickFile: noop, onDropFiles: noop, chatEndRef: createRef<HTMLDivElement>(), inputRef: createRef<HTMLTextAreaElement>(),
  }));
}

const ask: AskMsg = {
  id: "a1", role: "assistant", kind: "ask", text: "Аль аяллыг хэлж байна?",
  options: [
    { label: "НОРВЕЛ ХОТЫН АЯЛАЛ", hint: "идэвхтэй · дараагийн гаралт 12-р сарын 27", answer: "норвел цуцал [аялал: «НОРВЕЛ ХОТЫН АЯЛАЛ» trip_id=t-1]" },
    { label: "НОРВЕЛ – ШИНЭ ЖИЛИЙН АЯЛАЛ", hint: "идэвхтэй", answer: "норвел цуцал [аялал: «НОРВЕЛ – ШИНЭ ЖИЛИЙН АЯЛАЛ» trip_id=t-2]" },
  ],
  allowCustom: true, customPlaceholder: "Аяллын нэрийг бичих…",
};

test("a question from the assistant shows its choices as buttons with their hints, and invites typing instead", () => {
  const html = render([{ id: "m1", role: "admin", text: "норвел цуцал" }, ask]);
  assert.ok(html.includes("Аль аяллыг хэлж байна?"));
  assert.ok(html.includes("НОРВЕЛ ХОТЫН АЯЛАЛ") && html.includes("НОРВЕЛ – ШИНЭ ЖИЛИЙН АЯЛАЛ"));
  assert.ok(html.includes("дараагийн гаралт 12-р сарын 27"), "the hint is shown under the choice");
  assert.equal(html.includes("trip_id=t-1"), false, "the answer token never reaches the screen");
  assert.ok(html.includes("Эсвэл доор бичээрэй"));
  assert.ok(html.includes('placeholder="Аяллын нэрийг бичих…"'), "the composer offers to take the typed answer");
});

test("once answered, the chosen option stays marked and the others are no longer buttons to press", () => {
  const html = render([{ ...ask, answered: "НОРВЕЛ ХОТЫН АЯЛАЛ" }]);
  assert.ok(html.includes('aria-pressed="true"'));
  assert.equal(html.includes("Эсвэл доор бичээрэй"), false);
  assert.ok((html.match(/disabled=""/g) || []).length >= 2, "both choices are disabled after the answer");
});

test("the welcome screen offers example instructions written on a real trip", () => {
  const trip = { id: "t-9", route_name: "ВЭЛМОР АРЛЫН АЯЛАЛ", status: "active", extra: {} } as unknown as TravelTrip;
  const html = render([], [trip]);
  assert.ok(html.includes("«ВЭЛМОР АРЛЫН АЯЛАЛ» 12/27 дүүрсэн"));
  assert.ok(html.includes("хүүхэд 300 мянгаар бага"));
  assert.ok(html.indexOf("Жишээ заавар") < html.indexOf("Постер, үнийн жагсаалт оруулах"), "examples come before the file upload");
});

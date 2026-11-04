import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantTab } from "../src/components/admin/AssistantTab";
import { ComposerActionMenu, QUICK_ACTIONS, QuickActionList } from "../src/components/admin/AssistantQuickActions";

const noop = () => undefined;

function renderTab(messages: unknown[] = []) {
  return renderToStaticMarkup(createElement(AssistantTab, {
    messages: messages as never,
    existingTrips: [],
    aiInput: "",
    setAiInput: noop,
    attachedFiles: [],
    onRemoveAttachedFile: noop,
    dragOver: false,
    setDragOver: noop,
    busy: false,
    busyLabel: "",
    busyProgress: null,
    applyBusyId: "",
    clarifyBusyId: "",
    onSend: noop,
    onQuickAction: noop,
    onEditTripPrice: noop,
    onNewTrip: noop,
    onApply: noop,
    onRollback: noop,
    onSubmitClarificationForm: noop,
    onCancelProposal: noop,
    onPickFile: noop,
    onDropFiles: noop,
    chatEndRef: createRef<HTMLDivElement>(),
    inputRef: createRef<HTMLTextAreaElement>(),
  }));
}

test("the welcome screen lists the five actions once, with the file upload first and no trip picker open", () => {
  const html = renderTab();
  for (const entry of QUICK_ACTIONS) {
    assert.equal(html.split(entry.label).length - 1, 1, `${entry.label} appears exactly once`);
  }
  assert.ok(html.indexOf("Постер, үнийн жагсаалт оруулах") < html.indexOf(QUICK_ACTIONS[0].label), "upload comes before the action list");
  assert.equal(html.includes("Сонгох аяллууд"), false, "no trip list until an action starts");
  assert.ok(html.includes('aria-haspopup="menu"'), "the composer offers the + menu");
});

test("inside a conversation the actions live only in the composer menu, so the thread stays one surface", () => {
  const html = renderTab([{ id: "m1", role: "admin", text: "Сайн уу" }]);
  for (const entry of QUICK_ACTIONS) assert.equal(html.includes(entry.label), false, `${entry.label} not shown as a standing button`);
  assert.ok(html.includes('aria-haspopup="menu"'));
  assert.ok(html.includes("Сайн уу"));
});

test("the action list and the composer menu offer the same actions", () => {
  const list = renderToStaticMarkup(createElement(QuickActionList, { onStart: noop, busy: false }));
  const menu = renderToStaticMarkup(createElement(ComposerActionMenu, { onStart: noop, onPickFile: noop, busy: false, menuId: "m" }));
  for (const entry of QUICK_ACTIONS) assert.ok(list.includes(entry.label), entry.label);
  assert.equal(menu.includes('role="menu"'), false, "the menu is closed until opened");
});

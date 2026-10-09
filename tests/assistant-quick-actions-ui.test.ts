import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantQuickActions } from "../src/components/admin/AssistantQuickActions";

test("the five quick actions render as buttons, with no list open until one is chosen", () => {
  const html = renderToStaticMarkup(createElement(AssistantQuickActions, {
    trips: [], busy: false, onQuick: () => undefined, onEditPrice: () => undefined, onNewTrip: () => undefined,
  }));
  for (const label of ["Аялал цуцлах", "Суудал шинэчлэх", "Үнэ өөрчлөх", "Хоол", "Шинэ аялал"]) assert.ok(html.includes(label), label);
  assert.equal(html.includes("Аяллын нэрээр хайх"), false);
});

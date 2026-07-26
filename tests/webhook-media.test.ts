import assert from "node:assert/strict";
import test from "node:test";
import { isHandoffRequest } from "../src/lib/handoffDetection";

test("frustrated customer messages trigger human handoff without custom keywords", () => {
  const cases = [
    "i hate you",
    "chatbot you are giving me wrong answer",
    "\u0411\u043e\u0442 \u0431\u0443\u0440\u0443\u0443 \u0445\u0430\u0440\u0438\u0443\u043b\u0430\u0430\u0434 \u0431\u0430\u0439\u043d\u0430",
    "\u0445\u0443\u0434\u043b\u0430\u0430 \u0445\u044d\u043b\u044d\u044d\u0434 \u0431\u0430\u0439\u043d\u0430",
    "\u0430\u0440\u0447\u0430\u0430\u0433\u04af\u0439 \u044e\u043c\u0434\u0430\u0430",
    "archaagumda",
  ];

  for (const text of cases) {
    assert.equal(isHandoffRequest(text, []), true, text);
  }
});

test("normal travel questions do not trigger frustration handoff", () => {
  const cases = [
    "\u0038 \u0441\u0430\u0440\u044b\u043d \u0430\u044f\u043b\u0430\u043b \u0431\u0430\u0439\u043d\u0430 \u0443\u0443",
    "\u0411\u044d\u0439\u0434\u0430\u0439\u0445\u044d \u0430\u044f\u043b\u0430\u043b \u0445\u044d\u0434 \u0432\u044d",
    "\u0032 \u0442\u043e\u043c \u0445\u04af\u043d \u0031 \u0445\u04af\u04af\u0445\u044d\u0434 \u044f\u0432\u0431\u0430\u043b \u043d\u0438\u0439\u0442 \u0445\u044d\u0434 \u0432\u044d",
    "\u0428\u0430\u043d\u0445\u0430\u0439 \u0437\u0443\u0440\u0430\u0433",
  ];

  for (const text of cases) {
    assert.equal(isHandoffRequest(text, []), false, text);
  }
});

test("configured handoff keywords still work", () => {
  assert.equal(
    isHandoffRequest(
      "\u0437\u04e9\u0432\u043b\u04e9\u0445 \u0445\u044d\u0440\u044d\u0433\u0442\u044d\u0439 \u0431\u0430\u0439\u043d\u0430",
      ["\u0437\u04e9\u0432\u043b\u04e9\u0445"],
    ),
    true,
  );
});

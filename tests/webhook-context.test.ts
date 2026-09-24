import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("explicit trip request does not inherit previous destination context", async () => {
  applyTestEnv();
  const webhookModule = await import("../src/pages/api/webhook");

  const result = webhookModule.buildContextualUserText(
    [
      { role: "user" as const, text: "lumia aylal medeelel awy" },
      { role: "assistant" as const, text: "Лумиа чиглэлд 2 өөр аялал байна..." },
    ],
    "Вэлмор нислэгтэй аяллын хөтөлбөр үзэх",
  );

  assert.equal(result, "Вэлмор нислэгтэй аяллын хөтөлбөр үзэх");
});

test("short referential follow-up still keeps recent user context", async () => {
  applyTestEnv();
  const webhookModule = await import("../src/pages/api/webhook");

  const result = webhookModule.buildContextualUserText(
    [
      { role: "user" as const, text: "Альфа + Зэт хаалга шууд нислэгтэй аялал" },
      { role: "assistant" as const, text: "Үнэ, зураг, хөтөлбөрийн аль нь хэрэгтэй вэ?" },
    ],
    "зураг",
  );

  assert.equal(
    result,
    "Альфа + Зэт хаалга шууд нислэгтэй аялал\n зураг",
  );
});

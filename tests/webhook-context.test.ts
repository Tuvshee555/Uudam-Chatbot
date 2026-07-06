import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("explicit trip request does not inherit previous destination context", async () => {
  applyTestEnv();
  const webhookModule = await import("../src/pages/api/webhook");

  const result = webhookModule.buildContextualUserText(
    [
      { role: "user" as const, text: "shanghai aylal medeelel awy" },
      { role: "assistant" as const, text: "Шанхай чиглэлд 2 өөр аялал байна..." },
    ],
    "Бээжин нислэгтэй аяллын хөтөлбөр үзэх",
  );

  assert.equal(result, "Бээжин нислэгтэй аяллын хөтөлбөр үзэх");
});

test("short referential follow-up still keeps recent user context", async () => {
  applyTestEnv();
  const webhookModule = await import("../src/pages/api/webhook");

  const result = webhookModule.buildContextualUserText(
    [
      { role: "user" as const, text: "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал" },
      { role: "assistant" as const, text: "Үнэ, зураг, хөтөлбөрийн аль нь хэрэгтэй вэ?" },
    ],
    "зураг",
  );

  assert.equal(
    result,
    "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал\nзураг",
  );
});

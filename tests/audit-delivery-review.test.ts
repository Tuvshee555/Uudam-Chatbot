import assert from "node:assert/strict";
import test from "node:test";
import { presentAssistantReply } from "../src/lib/chatbotReplyPolicy";
import { sanitizeAssistantReply, stripRepeatedGreeting } from "../src/lib/reply";

test("reply formatting preserves bare and Markdown links byte for byte", () => {
  const url = "https://example.com/Context/trip_name_program.pdf?asset_key=Ab_Cd_Ef&signature=alpha__beta";
  for (const input of [url, `[Хөтөлбөр](${url})`, `**Хөтөлбөр**\n${url}`]) {
    const reply = presentAssistantReply({ reply: input, userText: "хөтөлбөр" });
    assert.ok(reply.includes(url), reply);
    assert.equal(sanitizeAssistantReply(reply), reply);
  }
});

test("reply cleanup retains distinct case-sensitive links and avoids placeholder collisions", () => {
  const first = "Хөтөлбөр: https://example.com/program?key=Ab_Cd";
  const second = "Хөтөлбөр: https://example.com/program?key=ab_cd";
  const reply = `REPLYURLPLACEHOLDER0END\n${first}\n\n${second}`;
  assert.equal(sanitizeAssistantReply(reply), reply);
});

test("repeated greeting cleanup retains a first paragraph that also answers the question", () => {
  for (const reply of [
    "Сайн байна уу! Том хүн: 1,234,567₮.\n\nЗөвхөн хоёр хүн нэг өрөөнд байрлах нөхцөлтэй.",
    "Hello! Adult fare: 1,234,567 MNT.\n\nShared room only.",
    "Hi!\nAdult fare: 1,234,567 MNT.\n\nShared room only.",
  ]) {
    const shown = presentAssistantReply({ reply, userText: "үнэ", hasPriorReply: true });
    assert.match(shown, /1,234,567/);
    assert.match(shown, /нөхцөлтэй|Shared room/);
  }
  assert.equal(stripRepeatedGreeting("Сайн байна уу! 😊\n\nХоол багтсан.", true), "Хоол багтсан.");
});

test("removing a scolding preface preserves the fare and its conditions", () => {
  for (const reply of [
    "As I mentioned, the adult fare is 1,234,567 MNT for a shared room.",
    "As I mentioned earlier, the adult fare is 1,234,567 MNT for a shared room.",
    "Өмнө нь хэлсэнчлэн, том хүн: 1,234,567₮, хоёр хүн нэг өрөөнд байрлана.",
  ]) {
    const shown = sanitizeAssistantReply(reply);
    assert.match(shown, /1,234,567/);
    assert.match(shown, /shared room|хоёр хүн нэг өрөөнд/);
    assert.doesNotMatch(shown, /as I mentioned|өмнө нь хэлсэн/i);
  }
});

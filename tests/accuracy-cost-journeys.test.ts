import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness } from "./helpers/conversationGateHarness";
import { evalCatalogue, evalSettings } from "./eval/catalogue";

/**
 * Customer journeys from the 2026-11-02 accuracy and cost work. Each one reproduces a turn the
 * dev evaluation (scripts/chatbot-eval.ts, tests/eval/dev.cases.ts) found wrong on the engine of
 * that day — a wrong fare, silence, a model call for a question the catalogue answers — on the
 * invented evaluation catalogue. The understanding model is unavailable (HTTP 429) unless a
 * journey says otherwise, so every answer below comes from the deterministic layers alone, as it
 * must during a provider outage.
 */
const offline = { unavailable: true } as const;
const text = (turn: { sends: Array<{ text: string }> }) => turn.sends.map((send) => send.text).join("\n");

test("accuracy and cost journeys on the invented catalogue", async (context) => {
  const harness = await conversationGateHarness(context, { settings: evalSettings });
  harness.catalog(evalCatalogue);
  const say = (sender: string, message: string, model: Parameters<typeof harness.turn>[2] = offline) => harness.turn(sender, message, model, undefined, { platform: "facebook" });
  try {
    await context.test("a request for a person in Latin letters or new wording hands off with a lead; a head count does not", async () => {
      for (const [sender, message] of [["h1", "hun bnu"], ["h2", "Хүнтэй ярьмаар байна"], ["h3", "chatbot bish hun heregtei"]]) {
        const turn = await say(sender, message);
        assert.match(text(turn), /ажилтан удахгүй/, message);
        assert.equal(turn.leads.length, 1, `${message}: a staff lead`);
      }
      const count = await say("h4", "Калдор 2 хүн байна уу");
      assert.doesNotMatch(text(count), /ажилтан удахгүй/);
      assert.equal(count.leads.length, 0);
    });

    await context.test("typed phone and address questions get the saved contact details without a model", async () => {
      for (const [sender, message, expected] of [["c1", "utasnii dugaar ugch uu", /7700 1234/], ["c2", "Оффис хаана байдаг вэ", /Энхтайваны/], ["c3", "Та нарын хаяг хаана вэ", /Энхтайваны/]] as const) {
        const turn = await say(sender, message, {});
        assert.match(text(turn), expected, message);
        assert.equal(turn.modelCalls + turn.answerModelCalls, 0, `${message}: no model`);
      }
    });

    await context.test("'за ok' and 'I'll ask tomorrow' get one short line, no lead and no model call", async () => {
      await say("ack", "Kaldor une");
      const ok = await say("ack", "za ok", {});
      assert.equal(ok.sends.length, 1);
      assert.doesNotMatch(text(ok), /Аль аялал|₮|дугаар/);
      assert.equal(ok.leads.length, 0);
      assert.equal(ok.modelCalls + ok.answerModelCalls, 0);
      const later = await say("ack", "margaash lavlah gesen yum", {});
      assert.equal(later.sends.length, 1);
      assert.doesNotMatch(text(later), /дугаар|Аль аялал/);
      assert.equal(later.leads.length, 0);
    });

    await context.test("a sold-out departure is called sold out, with the open dates, whether named with the trip or under it", async () => {
      const named = await say("so1", "Калдор 2 сарын 15-нд явах уу");
      assert.match(text(named), /2 сарын 15: суудал дүүрсэн/);
      assert.match(text(named), /3 сарын 6/);
      await say("so2", "Калдор");
      const under = await say("so2", "2 сарын 15");
      assert.match(text(under), /суудал дүүрсэн/);
      assert.doesNotMatch(text(under), /Тэр хугацаанд гарах аялал алга/);
    });

    await context.test("a weekly trip answers its schedule and its fares instead of going silent", async () => {
      const when = await say("w1", "Солмар халуун рашаан хэзээ гардаг вэ");
      assert.match(text(when), /Баасан гараг бүр/);
      assert.equal(when.leads.length, 0);
      const price = await say("w2", "Солмар халуун рашаан үнэ хэд вэ");
      assert.match(text(price), /590,000₮/);
      assert.doesNotMatch(text(price), /undefined/);
    });

    await context.test("fares that differ by hotel are shown per hotel; a hotel named without its stars is understood", async () => {
      const both = await say("ho1", "Норвел үнэ");
      assert.match(text(both), /Norvel Inn 3\*[\s\S]*990,000₮[\s\S]*Norvel Grand 5\*[\s\S]*1,390,000₮/);
      const grand = await say("ho1", "Norvel Grand");
      assert.match(text(grand), /1,390,000₮/);
      assert.doesNotMatch(text(grand), /(?<![\d,])990,000₮/);
      assert.equal(grand.selection?.hotel, "Norvel Grand 5*");
      const date = await say("ho1", "3 сарын 13");
      assert.match(text(date), /3 сарын 13/);
      assert.doesNotMatch(text(date), /Аль буудлын/);
    });

    await context.test("a one-year-old gets the infant fare, a four-year-old the child fare", async () => {
      const infant = await say("age1", "Лунариа парк 1 настай хүүхэд хэд вэ");
      assert.match(text(infant), /390,000₮/);
      assert.doesNotMatch(text(infant), /1,990,000₮/);
      const child = await say("age2", "Лунариа 4 настай хүүхэд хэд вэ");
      assert.match(text(child), /1,990,000₮/);
    });

    await context.test("'2 hun' are two adults with a total; twelve people stay a group for staff", async () => {
      await say("p1", "Kaldor");
      const two = await say("p1", "2 hun yavna");
      assert.match(text(two), /5,780,000₮/);
      // Ten or more: no computed total (group fares are staff's call); the per-person fare or the consultant line.
      const group = await say("p2", "Калдор 12 хүн явна");
      assert.doesNotMatch(text(group), /34,680,000₮|Нийт:/);
      assert.match(text(group), /зөвлөх|2,890,000₮/);
    });

    await context.test("a pick by quality under a list gets the trip card with its fares", async () => {
      await say("pick", "Вэлмор");
      const card = await say("pick", "шууд нислэгтэй нь");
      assert.match(text(card), /ВЭЛМОР ШУУД НИСЛЭГТЭЙ АЯЛАЛ[\s\S]*2,190,000₮/);
      assert.equal(card.selection?.tripId, "vel-direct");
    });

    await context.test("a bargain is answered with the real fare and the discount data, never a negotiated figure", async () => {
      const turn = await say("hag", "Вэлмор шууд нислэгтэй 1 сая төгрөгөөр болох уу");
      assert.match(text(turn), /2,190,000₮/);
      assert.match(text(turn), /хямдрал/);
      assert.doesNotMatch(text(turn), /1,000,000₮/);
    });

    await context.test("inclusions, visa and deposit questions in Latin letters are answered from the catalogue", async () => {
      assert.match(text(await say("i1", "Калдор хоол багтсан уу")), /өглөөний цай/i);
      assert.match(text(await say("i2", "Орвелиа шинжилгээтэй аялалд юу багтдаг вэ")), /Орчуулагч/);
      await say("i3", "Вэлмор шууд нислэгтэй аялал");
      assert.match(text(await say("i3", "ticket une tusdaa yu")), /Нислэгийн тийз/);
      assert.match(text(await say("i4", "kaldor viz heregtei yu")), /Виз шаардлагагүй/);
      assert.match(text(await say("i5", "velmor shuud nislegtei uridchilgaa hedn huvi")), /30%/);
    });

    await context.test("a generic follow-up on the selected trip is answered without the understanding model", async () => {
      await say("fu", "Вэлмор шууд нислэгтэй аялал", {});
      const food = await say("fu", "ene aylal dotor hool orson uu", {});
      assert.match(text(food), /Өглөөний цай/);
      assert.equal(food.modelCalls, 0, "the understanding model is not asked");
      assert.equal(food.answerModelCalls, 0);
      await say("fu2", "Lunaria park", {});
      const discount = await say("fu2", "huuhded hungulult bga yu", {});
      assert.match(text(discount), /Хямдралын нөхцөл/);
      assert.equal(discount.modelCalls, 0);
    });

    await context.test("catalogue questions — Latin, by price, for families, by land — list from the catalogue", async () => {
      assert.match(text(await say("cat1", "ymar aylal bga we")), /ВЭЛМОР/);
      assert.match(text(await say("cat2", "Хямдхан аялал байна уу")), /1\. СОЛМАР/);
      assert.match(text(await say("cat3", "Хүүхэдтэй явахад тохиромжтой аялал")), /ЛУНАРИА/);
      assert.match(text(await say("cat4", "gazraar yavdag aylal")), /ВЭЛМОР ГАЗРЫН|ОРВЕЛИЯ|СОЛМАР/);
    });

    await context.test("a hotel's distance to the sea and flight hours are not in the data: silence and a staff lead", async () => {
      for (const [sender, message] of [["f1", "Калдор буудал далайгаас хэр хол вэ"], ["f2", "Калдор руу хэдэн цаг нисэх вэ"]]) {
        const turn = await say(sender, message);
        assert.equal(turn.sends.length, 0, message);
        assert.equal(turn.leads.length, 1, message);
      }
    });
  } finally {
    await harness.close();
  }
});

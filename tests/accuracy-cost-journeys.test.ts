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

    await context.test("a model that flags a whole answerable question as unsupported does not silence it; a flagged sub-question still goes to staff", async () => {
      const visa = await say("mf1", "kaldor viz heregtei yu", { tripId: "kaldor-sea", topics: [], requestedFacts: [{ field: "other.unsupported", evidence: "kaldor viz heregtei yu" }] });
      assert.match(text(visa), /Виз шаардлагагүй/);
      const hotel = await say("mf2", "Kaldor buudal n ymr buudal we", { tripId: "kaldor-sea", topics: ["hotel"], requestedFacts: [{ field: "hotel.connectivity", evidence: "Kaldor buudal n ymr buudal we" }] });
      assert.match(text(hotel), /Kaldor Bay Resort/);
      const club = await say("mf3", "Калдор үнэ хэд вэ, хүүхдийн клуб байдаг уу", { tripId: "kaldor-sea", topics: ["price"], requestedFacts: [{ field: "other.unsupported", evidence: "хүүхдийн клуб байдаг уу" }] });
      assert.equal(club.sends.length, 0, "the unsupported part is not answered by omission");
      assert.equal(club.leads.length, 1);
    });

    await context.test("a pick by quality under a list never follows a model reading of a trip outside the list", async () => {
      await say("mp", "Вэлмор");
      const pick = await say("mp", "shuud nislegtei ni", { tripId: "norvel", certainty: "one" });
      assert.match(text(pick), /ВЭЛМОР ШУУД НИСЛЭГТЭЙ АЯЛАЛ[\s\S]*2,190,000₮/);
      assert.equal(pick.modelCalls, 0, "decided from the offered list");
      const month = await say("mp", "ireh sard", {});
      assert.match(text(month), /3 сарын 5/);
      assert.doesNotMatch(text(month), /НОРВЕЛ|КАЛДОР/);
    });

    await context.test("a malformed or empty understanding reply falls back to the catalogue matcher, never to silence or a guess", async () => {
      for (const [sender, raw] of [["bad1", "{not json"], ["bad2", ""], ["bad3", "{\"trips\":[\"T99\"],\"certainty\":\"one\"}"]]) {
        const turn = await say(sender, "Kaldor une", { rawUnderstanding: raw });
        assert.ok(turn.modelCalls > 0, "the model was asked");
        assert.match(text(turn), /2,890,000₮/, JSON.stringify(raw));
      }
    });

    await context.test("a message that is one trip's full name is answered without the understanding model; with a negation it is not", async () => {
      const named = await say("full1", "ВЭЛМОР ШУУД НИСЛЭГТЭЙ АЯЛАЛ үнэ хэд вэ", {});
      assert.equal(named.modelCalls, 0, "no understanding call");
      assert.equal(named.selection?.tripId, "vel-direct");
      assert.match(text(named), /2,190,000₮/);
      const negated = await say("full2", "ВЭЛМОР ШУУД НИСЛЭГТЭЙ АЯЛАЛ биш газрын аялал", {});
      assert.ok(negated.modelCalls > 0, "a negation needs the full reading");
    });

    // ── Gaps the held-out set found (same shapes, different wording where possible) ──
    await context.test("a budget question lists the trips under it instead of going silent", async () => {
      const turn = await say("ho-budget", "1.5 саяд багтах аялал байна уу");
      assert.match(text(turn), /СОЛМАР/);
      assert.match(text(turn), /1\.5 сая/);
      assert.doesNotMatch(text(turn), /КАЛДОР|1,500,000₮/);
    });

    await context.test("the model over-flagging an answerable sub-question or a hotel name does not silence it", async () => {
      const passport = await say("ho-mf1", "kaldor pasport heregtei yu", { tripId: "kaldor-sea", topics: [], requestedFacts: [{ field: "other.unsupported", evidence: "pasport heregtei yu" }] });
      assert.match(text(passport), /6 сарын хүчинтэй/);
      const inn = await say("ho-mf2", "Норвел Inn буудалтай нь хэд вэ", { tripId: "norvel", requestedFacts: [{ field: "hotel.connectivity", evidence: "Норвел Inn буудалтай нь" }] });
      assert.match(text(inn), /990,000₮/);
    });

    await context.test("cancellation, balance-payment and 'is X included' questions are answered from the trip", async () => {
      assert.match(text(await say("ho-t1", "Калдор цуцалвал мөнгө буцаах уу")), /буцаагдахгүй/);
      const balance = await say("ho-t2", "Калдор үлдэгдлээ хэзээ төлөх вэ");
      assert.match(text(balance), /7 хоногийн өмнө/);
      assert.doesNotMatch(text(balance), /Гарах өдрүүд/);
      assert.match(text(await say("ho-t3", "Орвелиа аялалд орчуулагч байгаа юу")), /Орчуулагч/);
    });

    await context.test("hotel facilities the data does not hold go to staff, also with a suffix or under a hotel name", async () => {
      for (const [sender, message] of [["ho-h1", "Калдор буудал усан сантай юу"], ["ho-h2", "Velmor Plaza wifi bga yu"]]) {
        const turn = await say(sender, message);
        assert.equal(turn.sends.length, 0, message);
        assert.equal(turn.leads.length, 1, message);
      }
    });

    await context.test("'данс аа', 'ойлголоо баярлалаа', Latin 'huuhed hed', a pick by way of travel and a party change need no model", async () => {
      const bank = await say("ho-b", "Данс аа явуулаач");
      assert.match(text(bank), /дансны мэдээлл/);
      assert.equal(bank.leads.length, 1);
      await say("ho-ack", "Kaldor une");
      const thanks = await say("ho-ack", "ойлголоо баярлалаа");
      assert.match(text(thanks), /Зүгээр/);
      assert.equal(thanks.leads.length, 0);
      await say("ho-child", "kaldor");
      assert.match(text(await say("ho-child", "huuhed hed")), /2,490,000₮/);
      await say("ho-way", "Вэлмор");
      assert.match(text(await say("ho-way", "gazraar yavdag ni")), /1,290,000₮/);
      await say("ho-party", "Вэлмор шууд нислэгтэй 2 том хүн");
      assert.match(text(await say("ho-party", "одоо 3 том хүн болсон")), /6,570,000₮/);
    });

    await context.test("a group larger than the seats left is told so and handed to staff; one programme day is answered alone", async () => {
      const group = await say("ho-g", "Калдор 3 сарын 6-нд 40 хүн явж болох уу");
      assert.doesNotMatch(text(group), /захиалга нээлттэй/);
      assert.match(text(group), /хүрэлцэх суудал үлдээгүй/);
      assert.match(text(group), /40 хүний групп/);
      assert.equal(group.leads.length, 1);
      const day = await say("ho-d", "velmor shuud nislegtei 3 dahi udur yu hiih ve");
      assert.match(text(day), /3-р өдөр: Далайн эрэг/);
      assert.doesNotMatch(text(day), /1-р өдөр|Шууд нислэгтэй аялал\./);
    });

    // Live replay shape (2026-11-02): "далайн аялал байна уу" after picking a land trip. The invented
    // catalogue's sea trip carries "далайн" in its name, so the same switch is tested with a kind no
    // trip name holds.
    await context.test("asking whether trips of another kind exist while on a trip lists them, whatever the model reads", async () => {
      await say("ho-kind", "Вэлмор газрын аялал");
      const direct = await say("ho-kind", "шууд нислэгтэй аялал байна уу", { tripId: "vel-land", certainty: "one" });
      assert.match(text(direct), /КАЛДОР|ВЭЛМОР ШУУД|ЛУНАРИА|НОРВЕЛ/);
      assert.doesNotMatch(text(direct), /ВЭЛМОР ГАЗРЫН|Аль гарах өдрөөр/);
      assert.equal(direct.modelCalls, 0, "decided from the catalogue");
    });

    await context.test("a package the model invents for a trip that sells none is ignored", async () => {
      const turn = await say("ho-pkg", "Орвелиа шинжилгээтэй аялалд юу багтдаг вэ", { tripId: "orvelia-checkup", topics: ["program", "includes"], package: "Орвелиа эрүүл мэндийн шинжилгээтэй аялал" } as never);
      assert.match(text(turn), /Орчуулагч/);
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

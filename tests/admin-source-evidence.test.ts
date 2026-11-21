import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { AIChangeProposal } from "../src/lib/travelTypes";

let enforceTextSourceEvidence: typeof import("../src/lib/travelAI").enforceTextSourceEvidence;

before(async () => {
  applyTestEnv();
  ({ enforceTextSourceEvidence } = await import("../src/lib/travelAI"));
});

test("text upload evidence guard removes invented prices and years", () => {
  const proposal: AIChangeProposal = {
    summary: "Read one trip",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "UUDAM TRAVEL AGENCY",
          route_name: "Макао – Жухай – Хайлин арал",
          adult_price: 2690000,
          child_price: 2290000,
          departure_dates: ["2026-10-30"],
          duration_text: "8 өдөр 7 шөнө",
          extra: {
            source_file_name: "makao.docx.part-001-of-001.txt",
            departure_date_groups: [
              {
                dates: ["2026-10-30"],
                adult_price: 2690000,
                child_price: 2290000,
              },
            ],
          },
        },
      },
    ],
  };

  const guarded = enforceTextSourceEvidence(proposal, [
    {
      label: "makao.docx.part-001-of-001.txt",
      contentText: [
        "ХҮҮХДИЙН АМРАЛТАД ЗОРИУЛСАН МАКАО – ЖУХАЙ – ХАЙЛИН-ГУАНЖОУ-ХӨХХОТ 5 ХОТЫН АЯЛАЛ",
        "7 ШӨНӨ 8 ӨДӨР",
        "10-Р САРЫН 30нд УЛААНБААТАР ХОТООС ГАНЦХАН УДАА ГАРНА",
        "Хоол: Өглөө цай",
      ].join("\n"),
    },
  ]);

  const fields = guarded.actions[0].fields!;
  assert.equal(fields.adult_price, undefined);
  assert.equal(fields.child_price, undefined);
  assert.deepEqual(fields.departure_dates, ["10 сарын 30"]);
  const extra = fields.extra as Record<string, unknown>;
  const groups = extra.departure_date_groups as Array<Record<string, unknown>>;
  assert.equal(groups[0].adult_price, undefined);
  assert.equal(groups[0].child_price, undefined);
  assert.equal(guarded.needs_confirmation, true);
  assert.match(guarded.conflicts.join("\n"), /энэ тоо олдсонгүй/);
  assert.match(guarded.conflicts.join("\n"), /жил нэмсэн/);
});

test("text upload evidence guard keeps prices that appear in the source", () => {
  const proposal: AIChangeProposal = {
    summary: "Read one trip",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        fields: {
          route_name: "Жухай аялал",
          adult_price: 2690000,
          child_price: 2290000,
          departure_dates: ["2026-10-30"],
        },
      },
    ],
  };

  const guarded = enforceTextSourceEvidence(proposal, [
    {
      label: "price.txt",
      contentText:
        "2026 оны 10 сарын 30\nТом хүн: 2,690,000 MNT\nХүүхэд: 2,290,000 MNT",
    },
  ]);

  assert.equal(guarded.actions[0].fields?.adult_price, 2690000);
  assert.equal(guarded.actions[0].fields?.child_price, 2290000);
  assert.deepEqual(guarded.actions[0].fields?.departure_dates, ["2026-10-30"]);
  assert.equal(guarded.needs_confirmation, false);
});

test("a price the admin typed beside the file is evidence; one that is in neither is still removed", () => {
  const make = (): AIChangeProposal => ({
    summary: "Read one trip", needs_confirmation: false, important_reason: "", conflicts: [],
    actions: [{
      action: "upsert",
      fields: {
        route_name: "Туршилтын хилийн аялал", adult_price: 1590000, child_price: 1390000, infant_price: 290000, departure_dates: ["2098-12-09"],
        extra: { source_file_name: "program.docx.part-001-of-001.txt", price_groups: [{ dates: ["2098-12-09"], adult_price: 1590000, child_price: 1390000 }] },
      },
    }],
  });
  const sources = [{ label: "program.docx.part-001-of-001.txt", contentText: "Туршилтын хилийн аялал. Ланд үнэ: том хүн 1450 юань, хүүхэд 1150 юань. 1-р өдөр 12/10." }];
  const note = "Шинэ аялал болгон нэм. 2098 оны 12 сарын 9-нд гарна. Зарлах үнэ: том хүн 1,590,000₮, хүүхэд 1,390,000₮.";

  const kept = enforceTextSourceEvidence(make(), sources, note);
  const fields = kept.actions[0].fields as Record<string, unknown>;
  assert.equal(fields.adult_price, 1590000, "typed by the admin: kept");
  assert.equal(fields.child_price, 1390000);
  assert.deepEqual(fields.departure_dates, ["2098-12-09"], "the year he typed stays on the date");
  assert.deepEqual((fields.extra as { price_groups: unknown[] }).price_groups, [{ dates: ["2098-12-09"], adult_price: 1590000, child_price: 1390000 }]);
  assert.equal(fields.infant_price, undefined, "in neither the file nor his words: removed");
  assert.deepEqual(kept.conflict_items?.filter((item) => item.type === "source_evidence_missing").map((item) => /290000/.test(item.text)), [true], "and asked once, for that price only");

  const without = enforceTextSourceEvidence(make(), sources);
  assert.equal((without.actions[0].fields as Record<string, unknown>).adult_price, undefined, "with no note the old check stands");
});

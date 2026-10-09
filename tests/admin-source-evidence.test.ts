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

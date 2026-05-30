import assert from "node:assert/strict";
import test from "node:test";
import type { AIChangeProposal } from "../src/lib/travelOps";
import { applyTestEnv } from "./helpers/env";

async function loadTravelOps() {
  applyTestEnv();
  return import("../src/lib/travelOps");
}

test("validation blocks patch actions without a target", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "patch",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [{ action: "patch", fields: { adult_price: 1000 } }],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.actions.length, 0);
  assert.equal(result.blocking_conflicts.length, 1);
  assert.equal(result.proposal.needs_confirmation, true);
});

test("validation marks suspicious child pricing for confirmation", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "upsert",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "Uudam",
          route_name: "Seoul tour",
          adult_price: 2000,
          child_price: 2500,
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.blocking_conflicts.length, 0);
  assert.equal(result.proposal.actions.length, 1);
  assert.equal(result.proposal.needs_confirmation, true);
  assert.match(result.proposal.conflicts.join(" "), /child price/i);
});

test("validation keeps uniquely matched upserts eligible", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "update existing",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        match: { operator_name: "Uudam", route_name: "Tokyo tour" },
        fields: { seats_left: 8 },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, [
    {
      id: "trip-1",
      operator_name: "Uudam",
      route_name: "Tokyo tour",
      status: "active",
      seats_left: 10,
      seats_total: 20,
      adult_price: 5000000,
      child_price: 4500000,
      currency: "MNT",
    },
  ]);

  assert.equal(result.blocking_conflicts.length, 0);
  assert.equal(result.proposal.actions.length, 1);
  assert.equal(result.auto_apply_ready, true);
});

test("validation warns before duplicate upsert creation", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "new trip",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "Uudam",
          route_name: "Beijing tour",
          adult_price: 3000000,
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, [
    {
      id: "trip-2",
      operator_name: "Uudam",
      route_name: "Beijing tour",
      status: "active",
      seats_left: 12,
      seats_total: 20,
      adult_price: 2900000,
      child_price: 2500000,
      currency: "MNT",
    },
  ]);

  assert.equal(result.blocking_conflicts.length, 0);
  assert.equal(result.proposal.needs_confirmation, true);
  assert.equal(result.auto_apply_ready, false);
  assert.match(result.proposal.conflicts.join(" "), /duplicate/i);
});

test("validation drops agency header-only fake trips", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "header noise",
    needs_confirmation: true,
    important_reason: "",
    conflicts: ["UUDAM TRAVEL AGENCY: departure date is unclear."],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "Uudam Travel",
          route_name: "UUDAM TRAVEL AGENCY",
          adult_price: 1_000_000,
          currency: "MNT",
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.actions.length, 0);
  assert.equal(result.proposal.conflicts.length, 0);
});

test("validation downgrades generic confirmation for complete clean new trips", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary:
      'Шинэ "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал" маршрутыг нэмж байна.',
    needs_confirmation: true,
    important_reason:
      "Файлнаас шинэ аяллын мэдээлэл уншигдсан тул баталгаажуулалт шаардлагатай.",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "UUDAM Travel",
          route_name: "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал",
          duration_text: "8 өдөр 7 шөнө",
          adult_price: 2_990_000,
          child_price: 2_660_000,
          currency: "MNT",
          departure_dates: ["4 сарын 25", "5 сарын 16", "6 сарын 27"],
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.needs_confirmation, false);
  assert.equal(result.proposal.important_reason, "");
  assert.equal(result.proposal.conflicts.length, 0);
  assert.equal(result.auto_apply_ready, true);
});

test("validation keeps generic confirmation when a new trip is incomplete", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "new incomplete trip",
    needs_confirmation: true,
    important_reason:
      "Файлнаас шинэ аяллын мэдээлэл уншигдсан тул баталгаажуулалт шаардлагатай.",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "UUDAM Travel",
          route_name: "Incomplete trip",
          adult_price: 2_990_000,
          currency: "MNT",
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.needs_confirmation, true);
  assert.equal(result.auto_apply_ready, false);
});

test("validation does not flag optional yuan add-ons as trip conflicts", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary:
      'Шинэ "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал" маршрутыг нэмж байна.',
    needs_confirmation: true,
    important_reason:
      "Файлнаас шинэ аяллын мэдээлэл уншигдсан тул баталгаажуулалт шаардлагатай.",
    conflicts: [
      '"Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал": нэмэлт төлбөрүүд CNY/юаниар байна.',
    ],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "UUDAM Travel",
          route_name: "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал",
          duration_text: "8 өдөр 7 шөнө",
          adult_price: 2_990_000,
          child_price: 2_660_000,
          currency: "MNT",
          departure_dates: ["4 сарын 25", "5 сарын 16", "6 сарын 27"],
          notes:
            "Нэмэлт төлбөр: Баофэн нуур 208 юань, шилэн гүүр 240 юань, шар луугийн агуй 228 юань, ганцаараа орох 800 юань.",
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.conflicts.length, 0);
  assert.equal(result.proposal.needs_confirmation, false);
  assert.equal(result.auto_apply_ready, true);
});

test("validation accepts recurring weekday departure schedules", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "weekly trip",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "UUDAM Travel",
          route_name: "ЖИНИН - МИНИ АВАТАР - ХӨХ ХОТ - ОРДОС ХОТЫН АЯЛАЛ",
          duration_text: "8 өдөр 7 шөнө",
          adult_price: 1_090_000,
          child_price: 790_000,
          currency: "MNT",
          departure_dates: ["Пүрэв гараг бүр"],
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.conflicts.length, 0);
  assert.deepEqual(result.proposal.actions[0]?.fields?.departure_dates, [
    "Пүрэв гараг бүр",
  ]);
  assert.equal(result.auto_apply_ready, true);
});

test("validation treats documented meal exceptions as notes, not conflicts", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "meal exceptions",
    needs_confirmation: true,
    important_reason:
      "Файлнаас шинэ аяллын мэдээлэл уншигдсан тул баталгаажуулалт шаардлагатай.",
    conflicts: [
      '"Тэнгэрийн хаалга - Жанжиажэ": зарим оройн хоол аялагчдын өөрсдийн зардлаар байна.',
    ],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "UUDAM Travel",
          route_name: "Тэнгэрийн хаалга - Жанжиажэ",
          duration_text: "10 өдөр 9 шөнө",
          adult_price: 2_550_000,
          child_price: 2_150_000,
          currency: "MNT",
          departure_dates: ["3 сарын 10", "4 сарын 7"],
          has_food: true,
          notes: "Зарим оройн хоол аялагчдын өөрсдийн зардлаар.",
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.conflicts.length, 0);
  assert.equal(result.proposal.needs_confirmation, false);
  assert.equal(result.auto_apply_ready, true);
});

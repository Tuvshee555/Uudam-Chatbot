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

test("transient AI proposal failures map to retryable HTTP responses", async () => {
  const { getAIProposalFailureResponse } = await loadTravelOps();
  const timeoutProposal: AIChangeProposal = {
    summary: "AI service took too long to answer.",
    needs_confirmation: true,
    important_reason: "Upstream gemini.generateContent timed out after 45000ms",
    conflicts: [],
    actions: [],
  };
  const rateLimitProposal: AIChangeProposal = {
    summary: "AI service is temporarily rate limited.",
    needs_confirmation: true,
    important_reason: "Upstream gemini.generateContent returned 429",
    conflicts: [],
    actions: [],
  };

  assert.equal(
    getAIProposalFailureResponse(timeoutProposal)?.statusCode,
    504,
  );
  assert.equal(
    getAIProposalFailureResponse(rateLimitProposal)?.statusCode,
    429,
  );
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
  assert.equal(result.proposal.actions[0]?.action, "patch");
  assert.equal(result.proposal.actions[0]?.trip_id, "trip-1");
  assert.equal(result.auto_apply_ready, true);
});

test("update-only instructions are detected in English and Mongolian", async () => {
  const { instructionForbidsTripCreation } = await loadTravelOps();
  assert.equal(
    instructionForbidsTripCreation("don't add trips, only fill the names"),
    true,
  );
  assert.equal(
    instructionForbidsTripCreation("Шинэ аялал битгий нэм, зөвхөн нэрийг нөх"),
    true,
  );
  assert.equal(instructionForbidsTripCreation("Шинэ аялал нэм"), false);
});

test("validation blocks creates in update-only mode", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "rename only",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [{
      action: "upsert",
      fields: { operator_name: "Uudam", route_name: "Бээжин" },
    }],
  };

  const result = validateAIChangeProposal(proposal, [], { forbidCreate: true });
  assert.equal(result.proposal.actions.length, 0);
  assert.equal(result.blocking_conflicts.length, 1);
  assert.match(result.blocking_conflicts[0], /шинэ аялал нэмэхгүй/);
});

test("validation blocks placeholder trip names", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "bad name",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [{
      action: "upsert",
      fields: { operator_name: "Uudam", route_name: "(Нэргүй аялал)" },
    }],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.actions.length, 0);
  assert.ok(result.blocking_conflicts.length > 0);
});

test("validation blocks two different names targeting one trip", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "ambiguous rename",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      { action: "patch", trip_id: "trip-1", fields: { route_name: "Бээжин" } },
      { action: "patch", trip_id: "trip-1", fields: { route_name: "Шанхай" } },
    ],
  };

  const result = validateAIChangeProposal(proposal, [{
    id: "trip-1",
    operator_name: "Uudam",
    route_name: "(Нэргүй аялал)",
    status: "active",
    seats_left: null,
    seats_total: null,
    adult_price: null,
    child_price: null,
    currency: "MNT",
  }]);
  assert.equal(result.blocking_conflicts.length, 1);
  assert.match(result.blocking_conflicts[0], /хоёр өөр нэр/);
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

test("validation silently drops agency header-only rows with no price data", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "header noise",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "Uudam Travel",
          route_name: "UUDAM TRAVEL AGENCY",
          // No price — this is a genuine header-only false positive
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.actions.length, 0);
  assert.equal(result.proposal.conflicts.length, 0);
});

test("validation flags agency-named route that has real price data instead of silently dropping", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "agency name used as route name but has price data",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
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
  // Action is preserved (real trip data) but flagged with a confirmation conflict
  assert.equal(result.proposal.actions.length, 1);
  assert.equal(result.proposal.needs_confirmation, true);
  assert.ok(
    result.proposal.conflicts.length > 0 || (result.proposal.conflict_items?.length ?? 0) > 0,
    "expected at least one conflict asking admin to rename the trip",
  );
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

test("validation accepts daily / everyday recurring departures", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  for (const phrase of ["Өдөр бүр", "daily", "Сар бүр", "өдөр болгон"]) {
    const proposal: AIChangeProposal = {
      summary: "daily trip",
      needs_confirmation: false,
      important_reason: "",
      conflicts: [],
      actions: [
        {
          action: "upsert",
          fields: {
            operator_name: "UUDAM Travel",
            route_name: `Тест аялал ${phrase}`,
            departure_dates: [phrase],
          },
        },
      ],
    };

    const result = validateAIChangeProposal(proposal, []);
    // The phrase must survive as a valid recurring date, not be dropped or
    // flagged as an untrustworthy date.
    assert.deepEqual(
      result.proposal.actions[0]?.fields?.departure_dates,
      [phrase],
      `"${phrase}" should be kept as a recurring departure`,
    );
    assert.equal(
      result.proposal.conflicts.some((c) => /could not be trusted|итгэх/i.test(c)),
      false,
      `"${phrase}" should not raise an untrusted-date conflict`,
    );
  }
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

test("structured warnings stay visible without blocking save", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const warning = "Буудлын нэрийн жижиг тайлбар бүдэг харагдаж байна.";
  const proposal: AIChangeProposal = {
    summary: "OCR warning",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [warning],
    conflict_items: [{ text: warning, severity: "warning", type: "ocr_suspect" }],
    actions: [{
      action: "upsert",
      fields: {
        operator_name: "UUDAM",
        route_name: "Шанхайн аялал",
        adult_price: 2_990_000,
        currency: "MNT",
        departure_dates: ["7 сарын 16"],
        duration_text: "8 өдөр 7 шөнө",
      },
    }],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.needs_confirmation, false);
  assert.equal(result.proposal.conflicts.length, 0);
  assert.equal(result.proposal.conflict_items?.[0]?.severity, "warning");
  assert.equal(result.auto_apply_ready, true);
});

test("corrupted OCR price patterns are promoted to blockers", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const conflict = '"Шанхайн аялал" хүүхдийн үнэ 2,6360,000₮ гэж бичигдсэн байна.';
  const proposal: AIChangeProposal = {
    summary: "bad OCR price",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [conflict],
    conflict_items: [{ text: conflict, severity: "warning", type: "ocr_suspect" }],
    actions: [{
      action: "upsert",
      fields: {
        operator_name: "UUDAM TRAVEL AGENCY",
        route_name: "Шанхайн аялал",
        adult_price: 2_990_000,
        departure_dates: ["7 сарын 16"],
        duration_text: "8 өдөр 7 шөнө",
      },
    }],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.needs_confirmation, true);
  assert.equal(result.proposal.conflict_items?.[0]?.severity, "blocker");
});

test("validation removes a missing-date conflict when dates were extracted", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const conflict = '"Тэнгэрийн хаалга" аяллын гарах огноо тодорхойгүй байна.';
  const proposal: AIChangeProposal = {
    summary: "dates found",
    needs_confirmation: true,
    important_reason: "",
    conflicts: [conflict],
    conflict_items: [{ text: conflict, severity: "blocker" }],
    actions: [{
      action: "upsert",
      fields: {
        operator_name: "UUDAM TRAVEL AGENCY",
        route_name: "Тэнгэрийн хаалга",
        adult_price: 2_990_000,
        departure_dates: ["7 сарын 16", "7 сарын 23"],
        duration_text: "8 өдөр 7 шөнө",
      },
    }],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.conflicts.length, 0);
  assert.equal(result.proposal.needs_confirmation, false);
});

test("validation removes generic multi-field extraction-miss questions", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const conflict = "Аяллын маршрут, оператор, үнэ, гарах огноо тодорхойгүй байна.";
  const proposal: AIChangeProposal = {
    summary: "fields actually found",
    needs_confirmation: true,
    important_reason: "",
    conflicts: [conflict],
    conflict_items: [{ text: conflict, severity: "blocker" }],
    actions: [{
      action: "upsert",
      fields: {
        operator_name: "UUDAM TRAVEL AGENCY",
        route_name: "Жанжиажэ аялал",
        adult_price: 3_290_000,
        departure_dates: ["8 сарын 8"],
        duration_text: "8 өдөр 7 шөнө",
      },
    }],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.conflicts.length, 0);
  assert.equal(result.proposal.needs_confirmation, false);
});

test("validation ignores filename-versus-operator pseudo conflicts", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const conflict = "Файлын нэр болон оператор UUDAM TRAVEL AGENCY зөрүүтэй байна.";
  const proposal: AIChangeProposal = {
    summary: "operator found",
    needs_confirmation: true,
    important_reason: "",
    conflicts: [conflict],
    conflict_items: [{ text: conflict, severity: "blocker" }],
    actions: [{
      action: "upsert",
      fields: {
        operator_name: "UUDAM TRAVEL AGENCY",
        route_name: "Хөх хотын аялал",
        adult_price: 890_000,
        departure_dates: ["Пүрэв гараг бүр"],
        duration_text: "5 өдөр 4 шөнө",
      },
    }],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.conflicts.length, 0);
  assert.equal(result.proposal.needs_confirmation, false);
});

test("validation keeps a real competing-header operator conflict", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const conflict =
    'Page 1-ийн хоёр өөр logo/header дээр "UUDAM TRAVEL AGENCY" болон "X TRAVEL" байна.';
  const proposal: AIChangeProposal = {
    summary: "two brands",
    needs_confirmation: true,
    important_reason: "",
    conflicts: [conflict],
    conflict_items: [{ text: conflict, severity: "blocker", type: "operator_conflict" }],
    actions: [{
      action: "upsert",
      fields: {
        operator_name: "UUDAM TRAVEL AGENCY",
        route_name: "Шанхайн аялал",
        adult_price: 2_990_000,
        departure_dates: ["7 сарын 16"],
        duration_text: "8 өдөр 7 шөнө",
      },
    }],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.needs_confirmation, true);
  assert.equal(result.proposal.conflicts.length, 1);
});

test("operator aliases normalize and match as one UUDAM brand", async () => {
  const { cleanFields } = await loadTravelOps();
  const { findTripMatches } = await import("../src/lib/travelDb");
  assert.equal(cleanFields({ operator_name: "Uudam" }).operator_name, "UUDAM TRAVEL AGENCY");
  const matches = findTripMatches([
    {
      id: "trip-uudam",
      operator_name: "Uudam Travel",
      route_name: "Бээжин",
      status: "active",
      seats_left: null,
      seats_total: null,
      adult_price: null,
      child_price: null,
      currency: "MNT",
    },
  ], "UUDAM TRAVEL AGENCY", "Бээжин");
  assert.equal(matches.length, 1);
});

test("cleanFields keeps https trip photo urls for Neon saves", async () => {
  const { cleanFields } = await loadTravelOps();
  assert.deepEqual(
    cleanFields({
      photo_urls: [
        " https://example.com/1.jpg ",
        "http://example.com/2.jpg",
        "not-a-url",
        "https://example.com/3.webp",
      ],
    }).photo_urls,
    ["https://example.com/1.jpg", "https://example.com/3.webp"],
  );
});

test("Mongolian grouped departure dates expand without inventing a year", async () => {
  const { expandMongolianDepartureDates } = await import("../src/lib/travelDb");
  assert.deepEqual(
    expandMongolianDepartureDates([
      "6 сарын 4, 11, 18, 25, 7 сарын 2, 9, 16, 23, 30",
    ]),
    [
      "6 сарын 4",
      "6 сарын 11",
      "6 сарын 18",
      "6 сарын 25",
      "7 сарын 2",
      "7 сарын 9",
      "7 сарын 16",
      "7 сарын 23",
      "7 сарын 30",
    ],
  );
});

test("hallucinated past-year ISO dates are stripped to month/day", async () => {
  const { expandMongolianDepartureDates } = await import("../src/lib/travelDb");
  // The model sometimes emits "2023-06-27" for a source that only said "6 сарын 27".
  // Any year before the current year is bogus and must drop to "M сарын D".
  assert.deepEqual(
    expandMongolianDepartureDates(["2023-06-27", "2023-07-18", "2023-08-08"]),
    ["6 сарын 27", "7 сарын 18", "8 сарын 8"],
  );
});

test("future ISO dates with a valid year are kept as-is", async () => {
  const { expandMongolianDepartureDates } = await import("../src/lib/travelDb");
  const nextYear = new Date().getFullYear() + 1;
  assert.deepEqual(
    expandMongolianDepartureDates([`${nextYear}-06-27`]),
    [`${nextYear}-06-27`],
  );
});

test("recurring schedule and exact dates are both retained", async () => {
  const { expandMongolianDepartureDates } = await import("../src/lib/travelDb");
  assert.deepEqual(
    expandMongolianDepartureDates([
      "Пүрэв гариг болгон — 6 сарын 4, 11, 18",
    ]),
    ["Пүрэв гариг болгон", "6 сарын 4", "6 сарын 11", "6 сарын 18"],
  );
});

test("date-based pricing conflict is suppressed when multiple departure dates exist", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  // Simulates the Shanghai + Tengeriin Haalga case: model flags multiple prices
  // as a conflict but the action already has multiple departure_dates.
  const proposal: AIChangeProposal = {
    summary: "Шанхай + Тэнгэрийн хаалга аялал нэмэх",
    needs_confirmation: true,
    important_reason: "Үнийн зөрүү байна.",
    conflicts: [
      '"Шанхай + Тэнгэрийн хаалга": аяллын үнэ 3,590,000₮, 3,660,000₮, 3,260,000₮ байна — өөр үнэ тодорхойлогдлоо.',
    ],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "UUDAM TRAVEL AGENCY",
          route_name: "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал",
          duration_text: "8 өдөр / 7 шөнө",
          adult_price: 3_660_000,
          child_price: 3_260_000,
          currency: "MNT",
          departure_dates: ["6 сарын 27", "7 сарын 18", "8 сарын 8"],
          notes: "6 сарын 27: Том хүн 3,590,000₮ / Хүүхэд 3,260,000₮; 7,8-р сар: Том хүн 3,660,000₮ / Хүүхэд 3,260,000₮",
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(
    result.proposal.conflicts.length,
    0,
    "date-based pricing conflict should be suppressed when multiple departure_dates exist",
  );
});

test("new upsert with sold_out status is overridden to active", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  // Model hallucinated sold_out from "суудал нөөцлөх" booking phrase
  const proposal: AIChangeProposal = {
    summary: "Жэжү арлын аялал нэмэх",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "UUDAM TRAVEL AGENCY",
          route_name: "Жэжү арлын аялал 2026",
          duration_text: "5 өдөр / 4 шөнө",
          adult_price: 4_290_000,
          child_price: 4_090_000,
          currency: "MNT",
          departure_dates: ["6 сарын 17", "7 сарын 10", "8 сарын 5"],
          status: "sold_out",
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(
    result.proposal.actions[0]?.fields?.status,
    "active",
    "sold_out on new upsert should be overridden to active",
  );
});

test("date-based pricing conflict suppressed when notes encode date→price mapping", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "date-price notes test",
    needs_confirmation: true,
    important_reason: "Үнийн зөрүү",
    conflicts: [
      '"Тэст аялал": үнэ 2,990,000₮, 3,100,000₮ байна — тодорхойгүй price өөрчлөлт.',
    ],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "UUDAM TRAVEL AGENCY",
          route_name: "Тэст аялал",
          adult_price: 3_100_000,
          currency: "MNT",
          departure_dates: ["6 сарын 15"],
          notes: "6 сарын 15: 2,990,000₮; 7 сарын 15: 3,100,000₮",
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(
    result.proposal.conflicts.length,
    0,
    "price conflict should be suppressed when notes encode date-price mapping",
  );
});

test("instructionForbidsTripCreation: bare нэмэхгүй does NOT forbid create", async () => {
  const { instructionForbidsTripCreation } = await loadTravelOps();
  // These phrases contain нэмэхгүй but are NOT trip-creation bans
  assert.equal(
    instructionForbidsTripCreation("Do not set total seats to 0 unless 0 means unknown"),
    false,
    "seat rule should not trigger forbidCreate",
  );
  assert.equal(
    instructionForbidsTripCreation("CREATE EXACTLY 5 NEW TOUR RECORDS"),
    false,
    "explicit create instruction should not trigger forbidCreate",
  );
  assert.equal(
    instructionForbidsTripCreation("суудлыг 0 болгохгүй"),
    false,
    "seat-0 rule should not trigger forbidCreate",
  );
});

test("instructionForbidsTripCreation: explicit бans DO forbid create", async () => {
  const { instructionForbidsTripCreation } = await loadTravelOps();
  assert.equal(
    instructionForbidsTripCreation("шинэ аялал нэмэхгүй, зөвхөн засна"),
    true,
    "шинэ аялал нэмэхгүй should forbid create",
  );
  assert.equal(
    instructionForbidsTripCreation("do not add new trips"),
    true,
    "do not add new trips should forbid create",
  );
  assert.equal(
    instructionForbidsTripCreation("аялал нэмэхгүй гэсэн"),
    true,
    "аялал нэмэхгүй гэсэн should forbid create",
  );
});

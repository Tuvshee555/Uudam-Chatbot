import assert from "node:assert/strict";
import test from "node:test";
import { buildProposalClarifications } from "../src/lib/adminProposalUtils";
import type { AIProposal } from "../src/lib/adminTypes";

function proposalWithConflict(conflict: string): AIProposal {
  return {
    summary: "review",
    needs_confirmation: true,
    important_reason: "",
    conflicts: [conflict],
    conflict_items: [{ text: conflict, severity: "blocker" }],
    actions: [],
  };
}

test("trip-name clarification asks for an exact name in plain Mongolian", () => {
  const questions = buildProposalClarifications(
    proposalWithConflict("Аяллын нэрийг тодорхойлох шаардлагатай байна."),
  );

  assert.equal(questions.length, 1);
  assert.match(questions[0].prompt, /Зөв нэрийг.*яг бич/i);
  assert.equal(questions[0].customPlaceholder, "Зөв аяллын нэрийг яг бичнэ үү");
  assert.ok(
    questions[0].options.some((option) =>
      option.label.includes("одоохондоо хадгалахгүй"),
    ),
  );
});

test("generic clarification labels describe the exact outcome", () => {
  const questions = buildProposalClarifications(
    proposalWithConflict("Үнэ бүдэг харагдаж байна."),
  );

  assert.deepEqual(
    questions[0].options.map((option) => option.label),
    ["Файлд бичсэн утгыг зөв гэж хадгалах", "Энэ өөрчлөлтийг хадгалахгүй"],
  );
  assert.doesNotMatch(
    questions[0].options.map((option) => option.label).join(" "),
    /Илэрсэнээр нь үлдээх|Болгоомжтой засах/,
  );
});

test("filename is never offered as an operator choice", () => {
  const questions = buildProposalClarifications(
    proposalWithConflict(
      'Файлын нэр "Шанхайн аялал" боловч оператор "UUDAM TRAVEL AGENCY" байна.',
    ),
  );
  assert.equal(questions.length, 0);
});

test("two competing main header brands still create a precise operator question", () => {
  const questions = buildProposalClarifications(
    proposalWithConflict(
      'Page 1-ийн хоёр өөр logo/header дээр "X TRAVEL" болон "Y TRAVEL" байна.',
    ),
  );
  assert.equal(questions.length, 1);
  assert.match(questions[0].prompt, /операторын нэр зөрчилтэй/i);
  assert.ok(questions[0].options.some((option) => option.label.includes("X TRAVEL")));
  assert.ok(questions[0].options.some((option) => option.label.includes("Y TRAVEL")));
});

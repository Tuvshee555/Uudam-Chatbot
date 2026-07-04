import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExtra } from "../src/lib/tripExtraSchema";
import { emptyBookingTerms, toBookingTermsForm } from "../src/lib/adminTypes";

test("normalizeExtra keeps booking_terms with all five trimmed fields", () => {
  const { extra } = normalizeExtra({
    booking_terms: {
      deposit: "  Урьдчилгаа 500,000₮ ",
      payment: "Дансаар",
      documents: "Гадаад паспорт",
      visa: "Хятадын виз",
      cancellation: "14 хоногийн өмнө буцаана",
      junk: "ignored",
    },
  });
  assert.deepEqual(extra.booking_terms, {
    deposit: "Урьдчилгаа 500,000₮",
    payment: "Дансаар",
    documents: "Гадаад паспорт",
    visa: "Хятадын виз",
    cancellation: "14 хоногийн өмнө буцаана",
  });
});

test("normalizeExtra defaults booking_terms to empty strings when absent", () => {
  const { extra } = normalizeExtra({});
  assert.deepEqual(extra.booking_terms, emptyBookingTerms());
});

test("toBookingTermsForm coerces partial / non-string input to a full form", () => {
  assert.deepEqual(toBookingTermsForm({ visa: "Виз хэрэгтэй", deposit: 123 }), {
    deposit: "",
    payment: "",
    documents: "",
    visa: "Виз хэрэгтэй",
    cancellation: "",
  });
  assert.deepEqual(toBookingTermsForm(null), emptyBookingTerms());
  assert.deepEqual(toBookingTermsForm("garbage"), emptyBookingTerms());
});

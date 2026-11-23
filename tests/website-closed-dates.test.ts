/**
 * The System page names a live trip whose website dates are closed for no readable price
 * (2026-11-22: a new trip's 20 dates, unnoticed until a customer was told it was full).
 * Invented trip names only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CLOSED_FOR_NO_PRICE_SQL, closedForNoPriceIssues } from "../src/lib/websiteClosedDates";

test("every date closed is critical, some dates a warning, none nothing", () => {
  const issues = closedForNoPriceIssues([
    { title: "НОРВЕЛ – ДАЛАЙН АЯЛАЛ", closed: 20, upcoming: 20 },
    { title: "ВЕЛМОР ХОТ", closed: 2, upcoming: 9 },
    { title: "АЛЬФА", closed: 0, upcoming: 4 },
  ]);
  assert.deepEqual(issues.map((issue) => [issue.severity, issue.key]), [
    ["critical", "website_closed_no_price:НОРВЕЛ – ДАЛАЙН АЯЛАЛ"],
    ["warning", "website_closed_no_price:ВЕЛМОР ХОТ"],
  ]);
  assert.match(issues[0].message, /20\/20 огноо хаалттай/);
  assert.match(issues[0].message, /насны ангилал эсвэл үнийн мөрийг шалгана уу/);
});

test("only dates the website paused for no price count: staff-paused dates keep their price, cancelled and past dates are left out", () => {
  assert.match(CLOSED_FOR_NO_PRICE_SQL, /d\.status = 'PAUSED'/);
  assert.match(CLOSED_FOR_NO_PRICE_SQL, /p->'price' IS NULL OR p->'price' = 'null'::jsonb/);
  assert.match(CLOSED_FOR_NO_PRICE_SQL, /NOT IN \('CANCELLED', 'DEPARTED'\)/);
  assert.match(CLOSED_FOR_NO_PRICE_SQL, /"isPublished"/);
  assert.match(CLOSED_FOR_NO_PRICE_SQL, />= \(NOW\(\) \+ interval '8 hours'\)::date/);
});

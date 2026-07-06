import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

async function loadQPayModule() {
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  return import("../src/lib/qpay");
}

test("isQPayConfigured is false when QPAY_ENABLED is unset (default off)", async () => {
  applyTestEnv();
  const qpay = await loadQPayModule();
  assert.equal(qpay.isQPayConfigured(), false);
});

test("isQPayConfigured is false when enabled but credentials are missing", async () => {
  applyTestEnv({
    QPAY_ENABLED: "true",
    QPAY_BASE_URL: "https://qpay.example.mn/v2",
    // username/password/invoice code intentionally left unset
  });
  const qpay = await loadQPayModule();
  assert.equal(qpay.isQPayConfigured(), false);
});

test("isQPayConfigured is true only when enabled AND every credential is present", async () => {
  applyTestEnv({
    QPAY_ENABLED: "true",
    QPAY_BASE_URL: "https://qpay.example.mn/v2",
    QPAY_USERNAME: "user",
    QPAY_PASSWORD: "pass",
    QPAY_INVOICE_CODE: "INV-1",
  });
  const qpay = await loadQPayModule();
  assert.equal(qpay.isQPayConfigured(), true);
});

test("isPaidCheck requires at least one row with status PAID (case-insensitive)", async () => {
  applyTestEnv();
  const qpay = await loadQPayModule();

  assert.equal(
    qpay.isPaidCheck({ count: 0, paid_amount: 0, rows: [] }),
    false,
    "no rows at all must not be treated as paid",
  );

  assert.equal(
    qpay.isPaidCheck({
      count: 1,
      paid_amount: 0,
      rows: [{ payment_id: "1", payment_status: "NEW", payment_date: "", payment_amount: 0 }],
    }),
    false,
    "a non-PAID status must not be treated as paid",
  );

  assert.equal(
    qpay.isPaidCheck({
      count: 1,
      paid_amount: 1000,
      rows: [{ payment_id: "1", payment_status: "paid", payment_date: "", payment_amount: 1000 }],
    }),
    true,
    "lowercase 'paid' must still count — QPay casing is not guaranteed",
  );

  assert.equal(
    qpay.isPaidCheck({
      count: 2,
      paid_amount: 1000,
      rows: [
        { payment_id: "1", payment_status: "NEW", payment_date: "", payment_amount: 0 },
        { payment_id: "2", payment_status: "PAID", payment_date: "", payment_amount: 1000 },
      ],
    }),
    true,
    "at least one PAID row among several is enough",
  );
});

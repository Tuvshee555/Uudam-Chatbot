import { test } from "node:test";
import assert from "node:assert/strict";
import { isTextFileBusy, launchWithRetry } from "../src/lib/chromiumLaunch";

const busy = () => Object.assign(new Error("browserType.launch: spawn ETXTBSY"), { code: undefined });
const noSleep = async () => undefined;

test("a browser binary still being unpacked (ETXTBSY) is retried until it starts", async () => {
  let calls = 0;
  const browser = await launchWithRetry(async () => {
    calls += 1;
    if (calls < 3) throw busy();
    return "browser";
  }, { sleep: noSleep });
  assert.equal(browser, "browser");
  assert.equal(calls, 3);
});

test("any other launch error is thrown at once, never retried", async () => {
  let calls = 0;
  await assert.rejects(launchWithRetry(async () => { calls += 1; throw new Error("missing libnss3.so"); }, { sleep: noSleep }), /libnss3/);
  assert.equal(calls, 1);
});

test("a binary that stays busy gives up after the attempt limit with the real error", async () => {
  let calls = 0;
  await assert.rejects(launchWithRetry(async () => { calls += 1; throw busy(); }, { attempts: 4, sleep: noSleep }), /ETXTBSY/);
  assert.equal(calls, 4);
});

test("ETXTBSY is recognised by code or by message", () => {
  assert.equal(isTextFileBusy(Object.assign(new Error("spawn failed"), { code: "ETXTBSY" })), true);
  assert.equal(isTextFileBusy(new Error("browserType.launch: spawn ETXTBSY\nCall log")), true);
  assert.equal(isTextFileBusy(new Error("ENOENT")), false);
  assert.equal(isTextFileBusy(null), false);
});

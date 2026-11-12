import { test } from "node:test";
import assert from "node:assert/strict";
import { isTextFileBusy, launchWithRetry, resetSharedExecutablePath, sharedExecutablePath } from "../src/lib/chromiumLaunch";

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

test("two launches at once wait for ONE unpack and never see a half-written browser", async () => {
  resetSharedExecutablePath();
  // Models @sparticuz/chromium: the file exists as soon as unpacking starts, but is only usable at the end.
  let unpacks = 0;
  let complete = false;
  const executablePath = async () => {
    unpacks += 1;
    if (unpacks === 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      complete = true;
    }
    return "/tmp/chromium";
  };
  const launch = async () => {
    const path = await sharedExecutablePath(executablePath);
    if (!complete) throw Object.assign(new Error("browserType.launch: spawn ETXTBSY"), { code: "ETXTBSY" });
    return path;
  };
  const results = await Promise.all([launch(), launch(), launch()]);
  assert.deepEqual(results, ["/tmp/chromium", "/tmp/chromium", "/tmp/chromium"], "every launch got the finished browser");
  assert.equal(unpacks, 1, "the browser was unpacked once for all launches");
  resetSharedExecutablePath();
});

test("a failed unpack is not remembered: the next launch tries again", async () => {
  resetSharedExecutablePath();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("ENOSPC: no space left on device");
    return "/tmp/chromium";
  };
  await assert.rejects(sharedExecutablePath(flaky), /ENOSPC/);
  assert.equal(await sharedExecutablePath(flaky), "/tmp/chromium", "the second launch unpacks again");
  assert.equal(calls, 2, "two unpack attempts");
  resetSharedExecutablePath();
});

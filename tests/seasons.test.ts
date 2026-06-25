// Set minimum env before importing modules that load env at init.
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.VERIFY_TOKEN ||= "test-verify-token";
process.env.TOKEN_PAGE ||= "test-page-token";
process.env.FACEBOOK_PAGE_ID ||= "1234567890";
process.env.META_APP_SECRET ||= "test-meta-secret";
process.env.ADMIN_SECRET ||= "test-admin-secret";
process.env.REDIS_STATE_ENABLED ||= "false";

import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

async function load() {
  applyTestEnv();
  return import("../src/lib/welcomeFlow");
}

test("resolveSeasons tolerates missing/partial data", async () => {
  const { resolveSeasons } = await load();
  assert.deepEqual(resolveSeasons(undefined), []);
  assert.deepEqual(resolveSeasons({ seasons: "nope" }), []);
  const out = resolveSeasons({
    seasons: [
      { id: "a", name: "Наадам", keywords: ["наадам"], photoUrls: ["https://x/y.jpg"], active: true },
      { name: "Partial" }, // missing fields → filled with defaults
      null,
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "Наадам");
  assert.equal(out[0].active, true);
  assert.equal(out[1].name, "Partial");
  assert.deepEqual(out[1].keywords, []);
  assert.equal(out[1].active, false);
});

test("getActiveSeason returns the active one or null", async () => {
  const { getActiveSeason } = await load();
  assert.equal(getActiveSeason([]), null);
  const seasons = [
    { id: "1", name: "A", keywords: [], photoUrls: [], active: false },
    { id: "2", name: "B", keywords: [], photoUrls: [], active: true },
  ];
  assert.equal(getActiveSeason(seasons)?.id, "2");
});

test("matchSeasonByText matches keywords (case-insensitive) and needs photos", async () => {
  const { matchSeasonByText } = await load();
  // Note: Mongolian declension drops vowels (наадам → наадмын, өвөл → өвлийн),
  // so owners should add stems ("наад", "өвл") as keywords. Matching is plain
  // substring (includes), reflected by these cases.
  const seasons = [
    { id: "1", name: "Наадам", keywords: ["наад", "naadam"], photoUrls: ["https://x/1.jpg"], active: true },
    { id: "2", name: "Өвөл", keywords: ["өвл", "winter"], photoUrls: ["https://x/2.jpg"], active: false },
  ];
  assert.equal(matchSeasonByText("Наадмын аялал байна уу?", seasons)?.id, "1");
  assert.equal(matchSeasonByText("do you have NAADAM trips", seasons)?.id, "1");
  assert.equal(matchSeasonByText("өвлийн аялал?", seasons)?.id, "2");
  assert.equal(matchSeasonByText("сайн байна уу", seasons), null);
});

test("matchSeasonByText ignores seasons with no photos", async () => {
  const { matchSeasonByText } = await load();
  const seasons = [
    { id: "1", name: "Наадам", keywords: ["наадам"], photoUrls: [], active: true },
  ];
  assert.equal(matchSeasonByText("наадам", seasons), null);
});

test("matchSeasonByText prefers the active season when both match", async () => {
  const { matchSeasonByText } = await load();
  const seasons = [
    { id: "off", name: "Off", keywords: ["аялал"], photoUrls: ["https://x/o.jpg"], active: false },
    { id: "on", name: "On", keywords: ["аялал"], photoUrls: ["https://x/n.jpg"], active: true },
  ];
  assert.equal(matchSeasonByText("аялал", seasons)?.id, "on");
});

test("resolveGreetingConfig reads defaultPhotoUrls", async () => {
  const { resolveGreetingConfig } = await load();
  const cfg = resolveGreetingConfig({
    greeting: {
      enabled: true,
      defaultPhotoUrls: ["https://x/a.jpg", "not-a-url", "https://x/b.jpg"],
    },
  });
  assert.deepEqual(cfg.defaultPhotoUrls, ["https://x/a.jpg", "https://x/b.jpg"]);
});

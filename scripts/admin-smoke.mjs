// Read-only browser smoke test of the admin panel. It never confirms a save, archive or
// send, so it is safe against production.
//
// The admin is Google sign-in only, and Google blocks automated browsers, so:
//   - against ANY target (production included): the signed-out checks — the card shows only
//     «Google-ээр нэвтрэх», there is no password field, nothing loads before sign-in,
//     POST /api/admin/session answers 405 and the retired x-admin-secret header gets 401;
//     with ADMIN_SMOKE_TOKEN (the read-only ADMIN_API_TOKEN) also: a Bearer GET is let in
//     and a Bearer write is refused (DELETE /api/admin/trips?all=true, which changes nothing
//     even when allowed);
//   - against http://localhost:<port> only: the full walk (sections in the URL, slim trip
//     list and full-trip editor, guarded bulk archive, lead search, JSON editor review,
//     sign-out), signed in with the local dev cookie (scripts/lib/devAdminCookie.mjs, minted
//     from this PC's .env.local; refused for any other host).
//
//   node scripts/admin-smoke.mjs [baseUrl]          (default https://uudam-chatbot.vercel.app)
//   ADMIN_SMOKE_TOKEN=<read-only token> also checks the Bearer rules; CHROME_PATH overrides
//   the browser executable. The retired-header probe counts once against the admin sign-in
//   throttle (20 per minute by default).
import { chromium } from "playwright-core";
import { devAdminCookieFromEnv } from "./lib/devAdminCookie.mjs";

const base = (process.argv[2] || "https://uudam-chatbot.vercel.app").replace(/\/$/, "");
const local = ["localhost", "127.0.0.1"].includes(new URL(base).hostname);
const token = (process.env.ADMIN_SMOKE_TOKEN || "").trim();
const chromePath = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// Server-side rules, without a browser.
const sessionPost = await fetch(`${base}/api/admin/session`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base, referer: `${base}/admin` },
  body: JSON.stringify({ secret: "smoke-not-a-password" }),
}).catch(() => null);
check("POST /api/admin/session (the old password sign-in) answers 405", sessionPost?.status === 405, String(sessionPost?.status ?? "no answer"));
const oldHeader = await fetch(`${base}/api/admin/trips?view=list`, { headers: { "x-admin-secret": "smoke-not-a-secret" } }).catch(() => null);
check("the retired x-admin-secret header is refused", oldHeader?.status === 401, String(oldHeader?.status ?? "no answer"));
const status = await fetch(`${base}/api/admin/session`, { cache: "no-store" }).then((res) => res.json()).catch(() => null);
check("the server says Google sign-in is set up", status?.google_sign_in === true, JSON.stringify({ google_sign_in: status?.google_sign_in }));
check("the session check no longer reports an open-access mode", status != null && !("open_access" in status));
if (token) {
  const bearer = { authorization: `Bearer ${token}` };
  const read = await fetch(`${base}/api/admin/system`, { headers: bearer }).then((res) => res.json()).catch(() => null);
  check("a Bearer GET with the read-only token is let in", read?.authorized === true);
  const write = await fetch(`${base}/api/admin/trips?all=true`, { method: "DELETE", headers: bearer }).catch(() => null);
  check("a Bearer write is refused", write?.status === 401, String(write?.status ?? "no answer"));
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "mn-MN" });
  const page = await context.newPage();
  const pageErrors = [];
  const requests = [];
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 200)));
  page.on("response", (response) => {
    if (response.url().includes("/api/")) requests.push(`${response.status()} ${response.request().method()} ${response.url().replace(base, "")}`);
  });

  await page.goto(`${base}/admin`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const google = page.getByRole("link", { name: "Google-ээр нэвтрэх" });
  check("a signed-out visitor sees «Google-ээр нэвтрэх»", await google.waitFor({ timeout: 120_000 }).then(() => true, () => false));
  check("the card asks for a Google account", await page.getByText("Google хаягаараа нэвтэрнэ үү.").isVisible().catch(() => false));
  check("there is no password field", (await page.locator('input[type="password"]').count()) === 0);
  check("no data is requested before sign-in", !requests.some((line) => line.startsWith("401 ")), requests.filter((line) => line.startsWith("401 ")).join(", "));
  check("the Google button starts the Google flow", (await google.getAttribute("href").catch(() => "")) === "/api/admin/google/start");

  if (!local) {
    console.log("\n(The signed-in walk runs only against http://localhost with the dev cookie.)");
  } else {
    await context.addCookies([devAdminCookieFromEnv(base)]);
    await page.reload({ waitUntil: "domcontentloaded" });
    const nav = page.locator("#admin-navigation");
    await nav.waitFor({ timeout: 120_000 });
    check("the local dev cookie signs in", true);
    const storedSecrets = await page.evaluate(() => Object.keys(localStorage).filter((key) => /secret/i.test(key)));
    check("no secret is kept in localStorage", storedSecrets.length === 0, storedSecrets.join(", "));
    const session = (await context.cookies()).find((cookie) => cookie.name === "uudam_admin");
    check("the session cookie is HttpOnly and SameSite=Strict", Boolean(session?.httpOnly && session.sameSite === "Strict"));

    await nav.getByRole("button", { name: "Аяллууд" }).click();
    check("the URL names the section", page.url().endsWith("#trips"), page.url());
    const firstEdit = page.locator("article").getByRole("button", { name: "Засах" }).first();
    await firstEdit.waitFor({ timeout: 120_000 });
    check("the trip list uses the slim view", requests.some((line) => /\/api\/admin\/trips\?.*view=list/.test(line)));
    await firstEdit.click();
    await page.getByRole("dialog").waitFor({ timeout: 60_000 });
    check("opening the editor fetches the full trip", requests.some((line) => /\/api\/admin\/trips\?id=/.test(line)));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    const archive = page.getByRole("button", { name: /Жагсаалтыг архивлах/ });
    if (await archive.count()) {
      await archive.click();
      const dialog = page.getByRole("dialog");
      const confirm = dialog.getByRole("button", { name: /аялал архивлах/ });
      check("bulk archive stays disabled until the word is typed", await confirm.isDisabled());
      await dialog.getByRole("button", { name: "Болих" }).click();
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await nav.waitFor({ timeout: 120_000 });
    check("a refresh keeps the section", (await page.locator("header").innerText()).includes("Аяллууд"));

    await nav.getByRole("button", { name: "Хүсэлтүүд" }).click();
    const count = page.getByRole("status").filter({ hasText: "харагдаж байна" });
    await count.waitFor({ timeout: 120_000 });
    await page.getByLabel(/Хүсэлт хайх/).fill("99");
    check("lead search asks the server", await page.waitForResponse((response) => /\/api\/admin\/leads\?.*q=99/.test(response.url()), { timeout: 30_000 })
      .then(() => true, () => false));
    await page.goBack({ waitUntil: "commit" });
    await page.waitForTimeout(800);
    check("Back returns to the previous section", page.url().endsWith("#trips"), page.url());

    await nav.getByRole("button", { name: "JSON засвар" }).click();
    await page.getByRole("button", { name: /Өөрчлөлтийг шалгаад хадгалах/ }).waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => !document.querySelector("#admin-content .animate-spin"), null, { timeout: 120_000 }).catch(() => {});
    const height = await page.evaluate(() => document.querySelector("#admin-content")?.scrollHeight || 0);
    check("the JSON editor page has a sane height", height > 0 && height < 4000, `${height}px`);
    await page.getByRole("button", { name: /Өөрчлөлтийг шалгаад хадгалах/ }).click();
    const reviewTitle = await page.getByRole("dialog").locator("h2").first().innerText().catch(() => "");
    check("an unchanged catalogue has nothing to save", /өөрчлөлт алга/i.test(reviewTitle), reviewTitle);
    await page.getByRole("dialog").getByRole("button", { name: "Болих" }).click();

    await nav.getByRole("button", { name: "Гарах" }).click();
    await google.waitFor({ timeout: 30_000 });
    check("sign-out clears the session", !(await context.cookies()).some((cookie) => cookie.name === "uudam_admin"));
  }
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

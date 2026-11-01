// Read-only browser smoke test of the admin panel: sign-in, sections in the URL,
// the slim trip list and full-trip editor, the guarded bulk archive, lead search,
// the JSON editor review, sign-out. It never confirms a save, archive or send, so it
// is safe against production. One deliberately wrong secret counts once against
// the admin sign-in throttle (20 per minute by default).
//
//   ADMIN_SMOKE_SECRET_FILE=<file holding the admin secret> node scripts/admin-smoke.mjs [baseUrl]
//   (or ADMIN_SECRET=...; CHROME_PATH overrides the browser executable)
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const base = (process.argv[2] || "https://uudam-chatbot.vercel.app").replace(/\/$/, "");
const secret = (process.env.ADMIN_SMOKE_SECRET_FILE
  ? readFileSync(process.env.ADMIN_SMOKE_SECRET_FILE, "utf8")
  : process.env.ADMIN_SECRET || "").trim();
const chromePath = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!secret) {
  console.error("Set ADMIN_SMOKE_SECRET_FILE (or ADMIN_SECRET).");
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

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
  const password = page.locator('input[type="password"]');
  await password.waitFor({ timeout: 120_000 });
  check("a signed-out visitor sees the sign-in form", true);
  check("no data is requested before sign-in", !requests.some((line) => line.startsWith("401 ")));

  await password.fill("definitely-not-the-admin-secret");
  await page.locator('button[type="submit"]').click();
  check("a wrong secret says so", await page.getByRole("alert").filter({ hasText: "Нууц үг буруу" })
    .waitFor({ timeout: 90_000 }).then(() => true, () => false));

  await password.fill(secret);
  await page.locator('button[type="submit"]').click();
  await page.locator("#admin-navigation").waitFor({ timeout: 120_000 });
  const storedSecrets = await page.evaluate(() => Object.keys(localStorage).filter((key) => /secret/i.test(key)));
  check("the secret is not kept in localStorage", storedSecrets.length === 0, storedSecrets.join(", "));
  const session = (await context.cookies()).find((cookie) => cookie.name === "uudam_admin");
  check("the session cookie is HttpOnly and SameSite=Strict", Boolean(session?.httpOnly && session.sameSite === "Strict"));

  const nav = page.locator("#admin-navigation");
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
  await password.waitFor({ timeout: 30_000 });
  check("sign-out clears the session", !(await context.cookies()).some((cookie) => cookie.name === "uudam_admin"));
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

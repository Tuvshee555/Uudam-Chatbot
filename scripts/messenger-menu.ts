/**
 * Adds "Хүнтэй холбогдох" to the Page's Messenger persistent menu (src/lib/messengerMenu.ts),
 * keeping the owner's own menu items. Dry run by default: prints the current and planned menu.
 * --apply writes the current profile to --backup first, then sets the menu. Tokens are read from
 * FACEBOOK_PAGES (pageId:token) or META_NEW_PAGE_TOKEN_<pageId>, never printed.
 *
 *   node --env-file=.env.local --import tsx scripts/messenger-menu.ts --page=<page id>
 *   node --env-file=.env.local --import tsx scripts/messenger-menu.ts --page=<page id> --apply --backup=<file.json>
 * Undo: POST the backup's persistent_menu back to /me/messenger_profile.
 */
import { writeFileSync } from "node:fs";
import { GRAPH_API_BASE } from "../src/lib/metaGraph";
import { withHumanRequestItem, type PersistentMenu } from "../src/lib/messengerMenu";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const pageId = arg("page") || "";
const apply = process.argv.includes("--apply");
const backup = arg("backup");
if (!/^\d+$/.test(pageId)) throw new Error("--page=<numeric page id> is required");
if (apply && !backup) throw new Error("--apply needs --backup=<file.json>");

const fromRoster = (process.env.FACEBOOK_PAGES || "").split(",").map((entry) => entry.trim())
  .find((entry) => entry.slice(0, entry.indexOf(":")) === pageId)?.slice(pageId.length + 1);
const token = process.env[`META_NEW_PAGE_TOKEN_${pageId}`] || fromRoster || "";
if (!token) throw new Error(`no page token for ${pageId} in FACEBOOK_PAGES or META_NEW_PAGE_TOKEN_${pageId}`);

const fields = "get_started,persistent_menu,ice_breakers,greeting";
const current = await (await fetch(`${GRAPH_API_BASE}/me/messenger_profile?${new URLSearchParams({ fields, access_token: token })}`)).json() as
  { data?: Array<Record<string, unknown>>; error?: { message?: string; code?: number } };
if (current.error) throw new Error(`reading the profile failed: (${current.error.code}) ${current.error.message}`);
const profile = current.data?.[0] ?? {};
const menus = profile.persistent_menu as PersistentMenu[] | undefined;
const titles = (list?: PersistentMenu[]) => (list ?? []).map((menu) => `${menu.locale}: ${(menu.call_to_actions ?? []).map((action) => action.title).join(" | ")}`);
console.log("get_started:", JSON.stringify(profile.get_started ?? null));
console.log("current menu:", titles(menus));
const planned = withHumanRequestItem(menus);
console.log("planned menu:", titles(planned.menus));
if (!planned.changed) { console.log("Already present — nothing to do."); process.exit(0); }
if (!profile.get_started) throw new Error("Meta requires a Get Started button before a persistent menu; none is set");
if (!apply) { console.log("Dry run. Re-run with --apply --backup=<file.json> to write."); process.exit(0); }

writeFileSync(backup!, JSON.stringify({ pageId, savedAt: new Date().toISOString(), profile }, null, 2));
const response = await fetch(`${GRAPH_API_BASE}/me/messenger_profile?${new URLSearchParams({ access_token: token })}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persistent_menu: planned.menus }),
});
const result = await response.json() as { result?: string; error?: { message?: string; code?: number } };
if (!response.ok || result.error) throw new Error(`setting the menu failed: (${result.error?.code}) ${result.error?.message}`);
const after = await (await fetch(`${GRAPH_API_BASE}/me/messenger_profile?${new URLSearchParams({ fields: "persistent_menu", access_token: token })}`)).json() as
  { data?: Array<{ persistent_menu?: PersistentMenu[] }> };
console.log("menu now:", titles(after.data?.[0]?.persistent_menu));

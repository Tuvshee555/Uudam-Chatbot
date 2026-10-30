/**
 * The customer's Facebook name, for staff screens ("Ирсэн зургууд", leads).
 *
 * Read through the Conversations API (a page reads its own conversations under
 * pages_messaging; /{psid}?fields=name needs Advanced Access). It used to run only
 * for text messages, only on the first page, and un-awaited — on Vercel the lookup
 * was cut off with the response, so customers who sent only photos or voice notes
 * stayed "Хэрэглэгч …0274" forever although Facebook knew their name.
 */
import { waitUntil } from "@vercel/functions";
import { getEnv } from "./env";
import { queryNeon } from "./neonDb";
import { dbStoreSenderName } from "./travelSessionDb";
import { GRAPH_API_BASE } from "./metaGraph";

/** The sender's name as the page sees it, trying the page the message came to first. */
export async function lookupFacebookName(senderId: string, preferredPageId?: string): Promise<string | null> {
  const pages = [...getEnv().facebookPages].sort((a, b) => Number(b.pageId === preferredPageId) - Number(a.pageId === preferredPageId));
  for (const page of pages) {
    if (!page.pageId || !page.token) continue;
    try {
      const url = `${GRAPH_API_BASE}/${encodeURIComponent(page.pageId)}/conversations`
        + `?user_id=${encodeURIComponent(senderId)}&fields=participants&access_token=${encodeURIComponent(page.token)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { data?: Array<{ participants?: { data?: Array<{ name?: string; id?: string }> } }> };
      const person = (data.data?.[0]?.participants?.data ?? []).find((p) => p.id !== page.pageId && p.name?.trim());
      if (person?.name) return person.name.trim();
    } catch {
      // try the next page
    }
  }
  return null;
}

async function storedName(senderId: string): Promise<string> {
  const result = await queryNeon<{ display_name: string | null }>(`SELECT display_name FROM travel_senders WHERE sender_id = $1`, [senderId]);
  return String(result?.rows?.[0]?.display_name || "").trim();
}

/** Looks the name up and stores it; returns it (or "" when Facebook has none). */
export async function fillSenderName(senderId: string, pageId?: string): Promise<string> {
  const name = await lookupFacebookName(senderId, pageId);
  if (name) await dbStoreSenderName(senderId, name);
  return name || "";
}

const checked = new Set<string>();

/** Once per warm instance per sender, only while the name is unknown; outlives the reply. */
export function rememberSenderName(senderId: string, pageId: string): void {
  if (!senderId || checked.has(senderId)) return;
  checked.add(senderId);
  const work = (async () => {
    if (await storedName(senderId)) return;
    await fillSenderName(senderId, pageId);
  })().catch(() => {});
  try {
    waitUntil(work);
  } catch {
    // outside a Vercel request (tests, scripts): the promise still runs
  }
}

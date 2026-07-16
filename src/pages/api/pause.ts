import type { NextApiRequest, NextApiResponse } from "next";
import {
  isPaused,
  listPaused,
  listRecent,
  pauseBot,
  resumeBot,
  storeSenderName,
} from "../../lib/pause";
import { getClientKey } from "../../lib/rateLimit";
import { requireAdminAccess } from "../../lib/adminAccess";
import { getBotControl, isPagePaused, listPageControls, setBotPaused, setPagePaused, setPhotoOnly, dbStoreSenderName } from "../../lib/travelOps";
import { getEnv } from "../../lib/env";
import { getPageDisplayName } from "../../lib/pages";
import {
  beginRequestTrace,
  finishRequestTrace,
  hashIdentifier,
} from "../../lib/observability";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.pause",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const access = await requireAdminAccess(req, res, "api.pause");
    if (!access) return;

    if (req.method === "GET") {
      const pageControls = await listPageControls();
      return res.status(200).json({
        paused: await listPaused(),
        recent: await listRecent(),
        control: await getBotControl(),
        pages: pageControls.map((c) => ({
          ...c,
          display_name: getPageDisplayName(c.page_id),
        })),
      });
    }

    if (req.method === "POST") {
      const { sender_id, action, duration_ms, reason, page_id } = req.body || {};

      // --- Per-page pause control ---
      if (
        action === "page_pause" ||
        action === "page_resume" ||
        action === "page_status"
      ) {
        if (typeof page_id !== "string" || !page_id.trim()) {
          return res.status(400).json({ error: "missing page_id" });
        }
        const pageId = page_id.trim();
        const known = getEnv().facebookPages.some((p) => p.pageId === pageId);
        if (!known) {
          return res.status(400).json({ error: "unknown page_id" });
        }
        if (action === "page_pause") {
          await setPagePaused(
            pageId,
            true,
            typeof reason === "string" ? reason : null,
          );
        } else if (action === "page_resume") {
          await setPagePaused(pageId, false, null);
          // The global flag is legacy, but older deployments may still have it
          // set. Clear it when resuming the primary page so it cannot reassert
          // the pause during a rolling deployment.
          if (pageId === getEnv().facebookPages[0]?.pageId) {
            await setBotPaused(false, null);
          }
        }
        return res.status(200).json({
          ok: true,
          page_id: pageId,
          paused: await isPagePaused(pageId),
        });
      }

      if (action === "global_pause") {
        await setBotPaused(true, typeof reason === "string" ? reason : null);
        return res.status(200).json({ ok: true, control: await getBotControl() });
      }
      if (action === "global_resume") {
        await setBotPaused(false, null);
        return res.status(200).json({ ok: true, control: await getBotControl() });
      }
      if (action === "global_status") {
        return res.status(200).json({ ok: true, control: await getBotControl() });
      }
      if (action === "photo_only_enable") {
        await setPhotoOnly(true);
        return res.status(200).json({ ok: true, control: await getBotControl() });
      }
      if (action === "photo_only_disable") {
        await setPhotoOnly(false);
        return res.status(200).json({ ok: true, control: await getBotControl() });
      }

      if (action === "backfill_names") {
        // Use Conversations API — page reads its own conversations (pages_messaging permission).
        // This works without Advanced Access, unlike the blocked /{psid}?fields=name endpoint.
        const env = getEnv();
        const pageId = env.facebookPages[0]?.pageId ?? "";
        const token = env.facebookPages[0]?.token ?? env.tokenPage;
        if (!token || !pageId) return res.status(400).json({ error: "no page token or pageId configured" });
        try {
          const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}/conversations?fields=participants&limit=100&access_token=${encodeURIComponent(token)}`;
          const fbRes = await fetch(url, { signal: AbortSignal.timeout(10000) });
          const data = (await fbRes.json()) as {
            data?: Array<{ participants?: { data?: Array<{ name?: string; id?: string }> } }>;
            error?: { message?: string };
          };
          if (!fbRes.ok || data.error) {
            return res.status(400).json({ error: data.error?.message ?? fbRes.status });
          }
          const convs = data.data ?? [];
          let filled = 0;
          for (const conv of convs) {
            for (const p of conv.participants?.data ?? []) {
              if (p.id && p.id !== pageId && p.name?.trim()) {
                await dbStoreSenderName(p.id, p.name.trim());
                filled++;
              }
            }
          }
          return res.status(200).json({ ok: true, total: convs.length, filled });
        } catch (e) {
          return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (action === "rename") {
        if (typeof sender_id !== "string" || !sender_id.trim()) {
          return res.status(400).json({ error: "missing sender_id" });
        }
        const newName = typeof req.body.name === "string" ? req.body.name.trim() : "";
        if (!newName) return res.status(400).json({ error: "missing name" });
        await storeSenderName(sender_id.trim(), newName);
        return res.status(200).json({ ok: true, sender_id: sender_id.trim(), name: newName });
      }

      if (!sender_id) return res.status(400).json({ error: "missing sender_id" });

      if (action === "pause") {
        await pauseBot(
          sender_id,
          typeof duration_ms === "number" ? duration_ms : undefined,
        );
        return res.status(200).json({ ok: true, sender_id, paused: true });
      }
      if (action === "resume") {
        await resumeBot(sender_id);
        return res.status(200).json({ ok: true, sender_id, paused: false });
      }
      if (action === "status") {
        return res.status(200).json({ sender_id, paused: await isPaused(sender_id) });
      }

      return res.status(400).json({
        error:
          "action must be pause | resume | status | global_pause | global_resume | global_status | page_pause | page_resume | page_status",
      });
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500, {
      clientHash: hashIdentifier(getClientKey(req)),
    });
  }
}

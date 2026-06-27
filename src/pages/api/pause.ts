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
import {
  getBotControl,
  isPagePaused,
  listPageControls,
  setBotPaused,
  setPagePaused,
  setPhotoOnly,
} from "../../lib/travelOps";
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

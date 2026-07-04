import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  createBroadcastRecord,
  finalizeBroadcast,
  getMessengerRecipients,
  listBroadcasts,
} from "../../../lib/travelOps";
import { sendTextMessage } from "../../../lib/messenger";
import { getEnv } from "../../../lib/env";
import {
  beginRequestTrace,
  finishRequestTrace,
  logInfo,
  logWarn,
} from "../../../lib/observability";

const env = getEnv();

const MAX_BROADCAST_RECIPIENTS = 500;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.broadcast",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.broadcast");
    if (!allowed) return;

    if (req.method === "GET") {
      const history = await listBroadcasts(20);
      return res.status(200).json({ ok: true, history });
    }

    if (req.method === "POST") {
      // Quarantined by default: blasting RESPONSE-type messages to past leads
      // outside Meta's 24h window is a policy violation that can suspend the
      // page. Requires an explicit BROADCAST_ENABLED=true opt-in.
      if (!env.broadcastEnabled) {
        return res.status(403).json({
          error: "broadcast_disabled",
          message:
            "Масс мессеж илгээх боломж хаалттай байна. Facebook-ийн 24 цагийн дүрмийг зөрчиж хуудас түдгэлзэх эрсдэлтэй тул үүнийг зөвхөн BROADCAST_ENABLED=true тохируулснаар идэвхжүүлнэ.",
        });
      }
      const { message, platform = "facebook" } = req.body || {};

      if (typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "message is required" });
      }
      if (!["facebook", "instagram"].includes(String(platform))) {
        return res.status(400).json({ error: "invalid platform" });
      }

      const trimmedMessage = message.trim().slice(0, 2000);

      // Use the first configured page token (broadcast sends from the primary page)
      const token = env.facebookPages[0]?.token || env.tokenPage;
      if (!token) {
        return res.status(400).json({ error: "page_token_not_configured" });
      }

      const recipients = await getMessengerRecipients(
        platform as "facebook" | "instagram",
        MAX_BROADCAST_RECIPIENTS,
      );

      if (recipients.length === 0) {
        return res.status(200).json({
          ok: true,
          sent: 0,
          failed: 0,
          message: "Илгээх хүлээн авагч олдсонгүй.",
        });
      }

      const record = await createBroadcastRecord(trimmedMessage, platform);

      logInfo("broadcast.started", {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        platform,
        recipientCount: recipients.length,
        broadcastId: record?.id,
      });

      // Fire and collect results — sequential to avoid rate limits
      let sentCount = 0;
      let failedCount = 0;
      for (const senderId of recipients) {
        try {
          await sendTextMessage(senderId, trimmedMessage, token, {
            requestId: trace.requestId,
            correlationId: trace.correlationId,
            source: "api.admin.broadcast",
          });
          sentCount++;
        } catch (error) {
          failedCount++;
          logWarn("broadcast.send_failed", {
            requestId: trace.requestId,
            correlationId: trace.correlationId,
            platform,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (record) {
        await finalizeBroadcast(record.id, sentCount, failedCount);
      }

      logInfo("broadcast.finished", {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        platform,
        sentCount,
        failedCount,
      });

      return res.status(200).json({
        ok: true,
        sent: sentCount,
        failed: failedCount,
      });
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}

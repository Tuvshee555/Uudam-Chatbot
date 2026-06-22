import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { getEnv } from "../../../lib/env";
import { createHash } from "crypto";

// Generates a Cloudinary signed upload URL so the browser can upload directly
// to Cloudinary without exposing the API secret client-side.

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.upload-image");
  if (!allowed) return;

  if (req.method !== "POST") return res.status(405).end();

  const env = getEnv();
  if (!env.cloudinaryCloudName || !env.cloudinaryApiKey || !env.cloudinaryApiSecret) {
    return res.status(503).json({ error: "cloudinary_not_configured" });
  }

  const timestamp = Math.round(Date.now() / 1000);
  const folder = "uudam-travel-trips";

  // Build the string to sign: alphabetical key=value pairs
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = createHash("sha256")
    .update(paramsToSign + env.cloudinaryApiSecret)
    .digest("hex");

  return res.status(200).json({
    signature,
    timestamp,
    cloudName: env.cloudinaryCloudName,
    apiKey: env.cloudinaryApiKey,
    folder,
  });
}

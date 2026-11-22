import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "../../../lib/env";
import { adminSignInAvailable, readAdminSession } from "../../../lib/adminAccess";
import { getBrand } from "../../../lib/brand";

/**
 * A secondary brand's admin (brand.ts) edits the same trips and settings as the primary's, and sees
 * the real fares there (brandAdminMode.ts): the admin says so once, at the top. Null for the primary.
 */
function brandNotice(): string | null {
  const brand = getBrand();
  if (brand.isPrimary) return null;
  const discount = brand.fareDiscountMnt > 0
    ? ` Энд Уудамын жинхэнэ үнэ харагдана; ${brand.nameMn}-ийн үйлчлүүлэгчид том хүн, хүүхдийн үнийг ${brand.fareDiscountMnt.toLocaleString("en-US")}₮ хямд харна.`
    : "";
  return `${brand.nameMn}-ийн админ. Аялал, тохиргоо Уудам Трэвэлтэй нэг: энд засвал хоёуланд нь өөрчлөгдөнө.${discount}`;
}
import {
  adminSessionCookie,
  clearedAdminSessionCookie,
  createAdminSessionToken,
  shouldRenewAdminSession,
} from "../../../lib/adminSession";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

/**
 * Admin panel session. Signing in happens only through Google (./google/start → callback).
 *   GET    → { authorized, google_sign_in, expires_at } (renews a session in use for a day).
 *            google_sign_in is false when nobody can sign in (no Google setup or a weak key).
 *   DELETE → signs this browser out
 * POST (the old password sign-in) is gone: 405.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const env = getEnv();
  res.setHeader("Cache-Control", "no-store");
  const trace = beginRequestTrace({
    route: "api.admin.session",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });
  try {
    if (req.method === "GET") {
      const session = readAdminSession(req);
      const googleSignIn = adminSignInAvailable(env);
      if (session && shouldRenewAdminSession(session.expiresAt)) {
        const renewed = createAdminSessionToken(env.adminSessionSecret, session.email);
        if (renewed) {
          res.setHeader("Set-Cookie", adminSessionCookie(renewed.token, renewed.expiresAt));
          return res.status(200).json({ ok: true, authorized: true, google_sign_in: googleSignIn, expires_at: renewed.expiresAt, brand_notice: brandNotice() });
        }
      }
      return res.status(200).json({
        ok: true,
        authorized: session != null,
        google_sign_in: googleSignIn,
        expires_at: session?.expiresAt ?? null,
        brand_notice: session ? brandNotice() : null,
      });
    }

    if (req.method === "DELETE") {
      res.setHeader("Set-Cookie", clearedAdminSessionCookie());
      return res.status(200).json({ ok: true, authorized: false });
    }

    res.setHeader("Allow", "GET, DELETE");
    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}

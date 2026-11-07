import type { NextApiResponse } from "next";
import { getDeps } from "../../../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute } from "../../../../../../lib/catalogue/admin/route";
import { firstQuery, isValidVersionId } from "../../../../../../lib/catalogue/admin/validation";
import { recordCounter } from "../../../../../../lib/observability";

const CHUNK_BYTES = 256 * 1024;

/** ASCII fallback + RFC 5987 UTF-8 name, so the saved file keeps its exact name everywhere. */
function contentDisposition(kind: "attachment" | "inline", fileName: string): string {
  const safe = fileName.replace(/[\r\n"\\]/g, "_");
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/** Streams the bytes in chunks so a large PDF never depends on a single buffered response. */
async function writeBytes(res: NextApiResponse, bytes: Buffer): Promise<void> {
  if (typeof res.write !== "function") {
    res.end(bytes);
    return;
  }
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const ok = res.write(bytes.subarray(offset, offset + CHUNK_BYTES));
    if (!ok && typeof res.once === "function") {
      await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  }
  res.end();
}

/**
 * Admin download of ANY version (draft, published, superseded) as application/pdf. Default is an
 * attachment; ?disposition=inline opens it in the browser's viewer. Never public: the public,
 * token-addressed file is /api/catalogue/file/<token>.
 */
export default catalogueRoute({
  route: "api.admin.catalogue.version_pdf",
  methods: ["GET"],
  async handle({ req, res }) {
    const id = firstQuery(req.query.id);
    if (!isValidVersionId(id)) throw new CatalogueHttpError(400, "invalid_request", "Хувилбарын дугаар буруу байна.");
    const disposition = firstQuery(req.query.disposition) === "inline" ? "inline" : "attachment";
    const store = await getDeps().store();
    await store.ensureCatalogueSchema();
    const found = await store.getVersionPdf(id);
    if (!found) throw new CatalogueHttpError(404, "version_not_found", "Хувилбар олдсонгүй.");
    recordCounter("catalogue.admin_downloads_total", 1, { edition: found.meta.edition, disposition });
    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", contentDisposition(disposition, found.meta.fileName));
    res.setHeader("Content-Length", String(found.bytes.length));
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    await writeBytes(res, found.bytes);
  },
});

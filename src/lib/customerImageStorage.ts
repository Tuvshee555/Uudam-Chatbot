import { get, put } from "@vercel/blob";

/** Customer documents use a private store; public trip-photo URLs are unsuitable here. */
export async function storeCustomerImage(buffer: Buffer, mimeType: string, key: string): Promise<string> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("private_blob_not_configured");
  const blob = await put(`customer-documents/${key}`, buffer, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: mimeType,
  });
  return blob.url;
}

export async function readCustomerImage(url: string) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("private_blob_not_configured");
  return get(url, { access: "private" });
}

import crypto from "crypto";

export class PayloadTooLargeError extends Error {
  maxBytes: number;

  constructor(maxBytes: number) {
    super(`Webhook payload exceeds configured limit (${maxBytes} bytes)`);
    this.name = "PayloadTooLargeError";
    this.maxBytes = maxBytes;
  }
}

function safeEqual(a: string, b: string) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
) {
  if (!appSecret || !header) return false;

  if (header.startsWith("sha256=")) {
    const expected = `sha256=${crypto
      .createHmac("sha256", appSecret)
      .update(rawBody)
      .digest("hex")}`;
    return safeEqual(expected, header);
  }

  if (header.startsWith("sha1=")) {
    const expected = `sha1=${crypto
      .createHmac("sha1", appSecret)
      .update(rawBody)
      .digest("hex")}`;
    return safeEqual(expected, header);
  }

  return false;
}

/**
 * During the Meta-app migration two apps deliver to this webhook, each signing with its own
 * secret. A delivery is valid when ANY configured secret verifies it; empty secrets are
 * skipped, so with only the old secret configured this is exactly the single-secret check.
 */
export function verifyMetaSignatureAny(
  rawBody: Buffer,
  header: string | undefined,
  appSecrets: Array<string>,
) {
  return appSecrets.some((secret) => secret && verifyMetaSignature(rawBody, header, secret));
}

/** Which app signed this delivery (its label), or null when no configured secret verifies it. */
export function matchMetaSignature<Label extends string>(
  rawBody: Buffer,
  header: string | undefined,
  appSecrets: Array<[Label, string]>,
): Label | null {
  for (const [label, secret] of appSecrets) {
    if (secret && verifyMetaSignature(rawBody, header, secret)) return label;
  }
  return null;
}

export async function readRawBodyLimited(
  stream: AsyncIterable<Buffer | string>,
  maxBytes: number,
  contentLengthHeader?: string,
): Promise<Buffer> {
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

export function parseWebhookJson(rawBody: Buffer): unknown {
  return JSON.parse(rawBody.toString("utf8"));
}

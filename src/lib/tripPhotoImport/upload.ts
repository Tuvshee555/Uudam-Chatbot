import { createHash } from "crypto";
import { getEnv } from "../env";
import { logError } from "../observability";

const CLOUDINARY_FOLDER = "uudam-travel-trips";

export type CloudinarySignature = {
  signature: string;
  timestamp: number;
  cloudName: string;
  apiKey: string;
  folder: string;
};

export function getCloudinarySignature(): CloudinarySignature | null {
  const env = getEnv();
  if (!env.cloudinaryCloudName || !env.cloudinaryApiKey || !env.cloudinaryApiSecret) {
    return null;
  }
  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = `folder=${CLOUDINARY_FOLDER}&timestamp=${timestamp}`;
  const signature = createHash("sha256")
    .update(paramsToSign + env.cloudinaryApiSecret)
    .digest("hex");
  return {
    signature,
    timestamp,
    cloudName: env.cloudinaryCloudName,
    apiKey: env.cloudinaryApiKey,
    folder: CLOUDINARY_FOLDER,
  };
}

export async function uploadImageToCloudinary(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<string> {
  const sig = getCloudinarySignature();
  if (!sig) {
    throw new Error("Cloudinary тохиргоо дутуу байна");
  }

  const formData = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  formData.append("file", blob, fileName);
  formData.append("api_key", sig.apiKey);
  formData.append("timestamp", String(sig.timestamp));
  formData.append("signature", sig.signature);
  formData.append("folder", sig.folder);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`,
    { method: "POST", body: formData },
  );

  const json = (await res.json()) as {
    secure_url?: string;
    error?: { message?: string };
  };
  if (!res.ok || !json.secure_url) {
    throw new Error(json.error?.message || "Cloudinary upload амжилтгүй");
  }
  return json.secure_url;
}

export async function uploadFileToCloudinary(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<string> {
  const sig = getCloudinarySignature();
  if (!sig) {
    throw new Error("Cloudinary тохиргоо дутуу байна");
  }

  const formData = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  formData.append("file", blob, fileName);
  formData.append("api_key", sig.apiKey);
  formData.append("timestamp", String(sig.timestamp));
  formData.append("signature", sig.signature);
  formData.append("folder", sig.folder);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${sig.cloudName}/auto/upload`,
    { method: "POST", body: formData },
  );

  const json = (await res.json()) as {
    secure_url?: string;
    error?: { message?: string };
  };
  if (!res.ok || !json.secure_url) {
    throw new Error(json.error?.message || "Cloudinary upload амжилтгүй");
  }
  return json.secure_url;
}

export async function uploadImagesToCloudinary(
  images: Array<{ buffer: Buffer; fileName: string; mimeType: string }>,
): Promise<{ urls: string[]; failures: Array<{ fileName: string; error: string }> }> {
  const urls: string[] = [];
  const failures: Array<{ fileName: string; error: string }> = [];

  for (const image of images) {
    try {
      const url = await uploadImageToCloudinary(
        image.buffer,
        image.fileName,
        image.mimeType,
      );
      urls.push(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "upload failed";
      logError("trip_photo_import.cloudinary_failure", { fileName: image.fileName, error: message });
      failures.push({ fileName: image.fileName, error: message });
    }
  }

  return { urls, failures };
}

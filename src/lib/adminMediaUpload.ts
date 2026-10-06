export async function uploadAdminMedia(
  file: File,
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>,
  uploadFetch: typeof fetch = fetch,
): Promise<string> {
  const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : null;
  if (!kind) throw new Error("Зураг эсвэл бичлэг сонгоно уу.");
  if (file.size > (kind === "image" ? 10 : 100) * 1024 * 1024) throw new Error(kind === "image" ? "Зураг 10MB-аас бага байх ёстой." : "Бичлэг 100MB-аас бага байх ёстой.");
  const response = await apiFetch("/api/admin/upload-image", { method: "POST" });
  if (!response.ok) throw new Error("Файл байршуулах тохиргоог шалгана уу.");
  const signature = await response.json() as { cloudName: string; apiKey: string; timestamp: number; signature: string; folder: string };
  const body = new FormData();
  body.append("file", file);
  body.append("api_key", signature.apiKey);
  body.append("timestamp", String(signature.timestamp));
  body.append("signature", signature.signature);
  body.append("folder", signature.folder);
  const result = await uploadFetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(signature.cloudName)}/${kind}/upload`, { method: "POST", body });
  if (!result.ok) throw new Error("Файл байршуулж чадсангүй. Дахин оролдоно уу.");
  const uploaded = await result.json() as { secure_url?: string };
  if (!uploaded.secure_url?.startsWith("https://")) throw new Error("Файлын холбоос ирсэнгүй.");
  return uploaded.secure_url;
}

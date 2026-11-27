/**
 * The assistant looks at the photos an admin attached (hotel photos), once: what each shows, the name on any sign,
 * and which photos belong to the same place. The agent itself only receives photo LINKS, so without this step it
 * cannot tell one hotel's pictures from another's (2026-11-25).
 *
 * Only photos already on our own Cloudinary are fetched (the page hosts every attachment first). Text out, nothing
 * written. One model call for all photos, so they are compared with each other.
 */
import { askOpenAIChatParts } from "../openaiFallback";
import { isHostedPhotoUrl } from "../tripPhotoEdit";

const MAX_PHOTOS = 24;
const MAX_BYTES = 4_000_000;

const LOOK_PROMPT = [
  "You are shown numbered photos of hotels (rooms, lobbies, entrances, pools, restaurants), in this order: photo 1, photo 2, …",
  "Answer in English, plain text, in two parts.",
  "PART 1 — one line per photo: 'N: <what it shows> | sign/text: <any name or lettering visible on a sign, wall or door, copied exactly, or none> | look: <wall colours, floor, ceiling lights, furniture, bed style>'.",
  "PART 2 — GROUPS: which photo numbers are from the SAME hotel (same room style, same lobby, same building). Name each group by the hotel name a sign in one of its photos shows, or 'no name visible'. A photo you cannot place goes alone.",
  "Never guess a hotel's name from its look: only a sign or lettering in the photos names a hotel.",
].join("\n");

async function bytesOf(url: string): Promise<{ mimeType: string; data: string }> {
  if (!isHostedPhotoUrl(url)) throw new Error("Зөвхөн манай сервер дээрх зургийг харна.");
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("Зургийг татаж чадсангүй.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error("Зураг хэтэрхий том байна.");
  const type = (response.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase();
  return { mimeType: /^image\/(?:jpeg|png|webp|gif)$/.test(type) ? type : "image/jpeg", data: buffer.toString("base64") };
}

export async function describeHostedPhotos(urls: string[]): Promise<string> {
  const list = urls.slice(0, MAX_PHOTOS);
  const images = await Promise.all(list.map(bytesOf));
  const parts = images.flatMap((image, index) => [{ text: `Photo ${index + 1}:` }, { inlineData: image }]);
  const result = await askOpenAIChatParts([{ text: LOOK_PROMPT }, ...parts], {
    model: "gpt-4o", temperature: 0, maxOutputTokens: 2_500, timeoutMs: 90_000, imageDetail: "high", source: "assistant.describe_photos",
  });
  const text = String(result?.text || "").trim();
  if (!text) throw new Error("Зургийг харж чадсангүй.");
  return text;
}

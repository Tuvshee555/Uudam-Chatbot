/**
 * Static assets read from the repo: the Noto fonts and the agency's original logo.
 * Both are read once per process. The logo is embedded exactly as stored (no decode, no re-encode),
 * so what the catalogue prints is the repo-approved file byte for byte.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CatalogueRenderError, type RenderFontFace } from "./renderTypes";
import { SANS, SERIF } from "./theme";

/** Repo-approved poster logo. Do not substitute another file or a text wordmark. */
export const LOGO_FILE = "public/poster/uudam-logo.jpg";

export const FONT_FILES: { file: string; family: string; weight: number; style: "normal" | "italic" }[] = [
  { file: "NotoSans-Regular.ttf", family: SANS, weight: 400, style: "normal" },
  { file: "NotoSans-Medium.ttf", family: SANS, weight: 500, style: "normal" },
  { file: "NotoSerif-SemiBold.ttf", family: SERIF, weight: 600, style: "normal" },
  { file: "NotoSerif-Italic.ttf", family: SERIF, weight: 400, style: "italic" },
];

export type StaticAssets = { fonts: RenderFontFace[]; logoDataUri: string; logoBytes: Buffer };

let cached: Promise<StaticAssets> | null = null;

export function repoRoot(): string {
  return process.cwd();
}

async function read(rel: string): Promise<Buffer> {
  try {
    // Fonts and the logo are listed explicitly in next.config.ts (outputFileTracingIncludes) for every
    // route that renders; without this opt-out the bundler traces the WHOLE project into each of them.
    return await readFile(path.join(/*turbopackIgnore: true*/ repoRoot(), rel));
  } catch (error) {
    throw new CatalogueRenderError("render_failed", `Каталогийн файл уншигдсангүй: ${rel}`, { cause: error });
  }
}

export function loadStaticAssets(): Promise<StaticAssets> {
  if (!cached) {
    const pending = (async () => {
      const [logoBytes, ...fontBytes] = await Promise.all([read(LOGO_FILE), ...FONT_FILES.map(f => read(`public/fonts/${f.file}`))]);
      if (logoBytes[0] !== 0xff || logoBytes[1] !== 0xd8) {
        throw new CatalogueRenderError("render_failed", `${LOGO_FILE} JPEG биш байна.`);
      }
      const fonts = FONT_FILES.map((f, i) => ({
        family: f.family,
        weight: f.weight,
        style: f.style,
        dataUri: `data:font/ttf;base64,${fontBytes[i]!.toString("base64")}`,
      }));
      return { fonts, logoBytes, logoDataUri: `data:image/jpeg;base64,${logoBytes.toString("base64")}` };
    })();
    cached = pending;
    pending.catch(() => {
      if (cached === pending) cached = null; // a missing file must not poison the process
    });
  }
  return cached;
}

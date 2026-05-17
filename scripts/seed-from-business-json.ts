/**
 * One-time importer: copies the static `data/business.json` modules into the
 * live Neon database as trip rows, for bootstrapping an EMPTY database.
 * After this runs the chatbot reads 100% from the database.
 *
 * Run:          npm run seed
 * Force re-run: npm run seed -- --force
 *
 * Each module gets a deterministic id (`seed-<index>`), so a forced re-run
 * updates existing rows in place instead of creating duplicates. By default
 * the script refuses to run when the database already has trips, so it can
 * never overwrite data the admin has since edited.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

type BusinessModule = {
  name?: string;
  duration?: string;
  price?: number | string;
  target?: string;
  description?: string;
};

function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function extractPrice(description: string, pattern: RegExp): number | null {
  const match = pattern.exec(description);
  return match ? parseNumber(match[1]) : null;
}

async function run() {
  const root = process.cwd();
  // .env.local has precedence over .env, so load it first.
  loadEnvFile(join(root, ".env.local"));
  loadEnvFile(join(root, ".env"));

  if (!process.env.NEON_DATABASE_URL) {
    console.error(
      "NEON_DATABASE_URL тохируулагдаагүй байна. .env файлаа шалгана уу.",
    );
    process.exit(1);
  }

  const jsonPath = join(root, "data", "business.json");
  if (!existsSync(jsonPath)) {
    console.error("data/business.json олдсонгүй.");
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as {
    modules?: BusinessModule[];
  };
  const modules = Array.isArray(raw.modules) ? raw.modules : [];
  if (modules.length === 0) {
    console.error("business.json дотор modules алга.");
    process.exit(1);
  }

  const force = process.argv.includes("--force");

  const { upsertTrip, ensureTravelSchema, getDbDiagnostics } = await import(
    "../src/lib/travelOps"
  );

  const ready = await ensureTravelSchema();
  if (!ready) {
    console.error("Өгөгдлийн сангийн схем бэлдэж чадсангүй.");
    process.exit(1);
  }

  const diagnostics = await getDbDiagnostics();
  if (diagnostics.trips > 0 && !force) {
    console.log(
      `Өгөгдлийн санд аль хэдийн ${diagnostics.trips} аялал байна.\n` +
        "Импорт хийсэнгүй — одоо байгаа өгөгдлийг хамгаалав.\n" +
        "Хүчээр дахин импортлох бол: npm run seed -- --force",
    );
    process.exit(0);
  }

  let imported = 0;
  let failed = 0;
  let index = -1;

  for (const entry of modules) {
    index += 1;
    const name = String(entry.name || "").trim();
    if (!name) continue;
    const description = String(entry.description || "").trim();

    let adultPrice: number | null =
      typeof entry.price === "number" ? Math.trunc(entry.price) : null;
    if (adultPrice == null) {
      adultPrice = extractPrice(description, /том хүн[\s:：-]*([\d,]+)/i);
    }
    const childPrice = extractPrice(description, /хүүхэд[\s:：-]*([\d,]+)/i);

    const looksYuan = /юань|yuan/i.test(description);
    const largestPrice = Math.max(adultPrice ?? 0, childPrice ?? 0);
    const currency =
      largestPrice >= 100000
        ? "MNT"
        : looksYuan || (largestPrice > 0 && largestPrice < 100000)
          ? "CNY"
          : "MNT";

    const duration = String(entry.duration || "").trim();
    const result = await upsertTrip({
      id: `seed-${index}`,
      fields: {
        operator_name: String(entry.target || "").trim() || "Unknown operator",
        route_name: name,
        duration_text: duration && duration !== "Тодорхойгүй" ? duration : "",
        adult_price: adultPrice,
        child_price: childPrice,
        currency,
        status: "active",
        source_description: description,
        notes: "data/business.json-оос автоматаар импортлогдсон",
      },
    });

    if (result) {
      imported += 1;
      console.log(`  ✓ ${name}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${name}`);
    }
  }

  console.log(
    `\nДуусав: ${imported} аялал импортлогдлоо${
      failed > 0 ? `, ${failed} амжилтгүй` : ""
    }.`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error("Seed алдаа:", error);
  process.exit(1);
});

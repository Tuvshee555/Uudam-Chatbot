import { Client } from "pg";
import { fileURLToPath } from "node:url";
import { collectBaseline, parseBaselineOptions, writePrivateBaseline } from "./lib/chatbotBaseline";

async function main() {
  const options = parseBaselineOptions(process.argv.slice(2));
  const connectionString = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Database configuration missing.");
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error("Invalid database configuration.");
  // Match neonDb TLS normalization without importing application initialization/logging.
  if (["prefer", "require", "verify-ca"].includes(url.searchParams.get("sslmode") || "")) url.searchParams.set("sslmode", "verify-full");
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000, query_timeout: 25_000,
    options: "-c default_transaction_read_only=on", application_name: "chatbot-baseline-read-only" });
  // pg asynchronous errors must never dump connection details or private rows.
  client.on("error", () => { process.exitCode = 1; });
  try {
    await client.connect();
    const artifact = await collectBaseline(client, options);
    const artifactPath = await writePrivateBaseline(fileURLToPath(new URL("../", import.meta.url)), artifact);
    console.log(JSON.stringify({ ...artifact.summary, artifactPath, reviewStatus: artifact.reviewStatus }));
  } finally {
    await client.end();
  }
}

main().catch(() => {
  console.error("Baseline export failed. Check arguments, DB access, safety bounds, and ignored tmp directory. No error details or customer content logged.");
  process.exitCode = 1;
});

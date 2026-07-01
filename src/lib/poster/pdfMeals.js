import { execFile } from "child_process";
import { existsSync } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function scriptPath() {
  const sourcePath = path.join(process.cwd(), "lib", "pdfMeals.py");
  if (existsSync(sourcePath)) return sourcePath;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "pdfMeals.py");
}

function pythonCandidates() {
  return [process.env.PYTHON, "python", "python3"].filter(Boolean);
}

async function runPython(pdfPath) {
  const script = scriptPath();
  let lastError = null;

  for (const python of pythonCandidates()) {
    try {
      const { stdout } = await execFileAsync(python, [script, pdfPath], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        timeout: 45_000,
      });
      const output = stdout || "{}";
      const jsonStart = output.indexOf("{");
      const jsonEnd = output.lastIndexOf("}");
      const json = jsonStart >= 0 && jsonEnd >= jsonStart ? output.slice(jsonStart, jsonEnd + 1) : output;
      return JSON.parse(json || "{}");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export async function extractPdfFacts(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uudam-pdf-"));
  const pdfPath = path.join(dir, "source.pdf");

  try {
    await fs.writeFile(pdfPath, buffer);
    const facts = await runPython(pdfPath);
    if (facts?.meals || facts?.days) return facts;
    return { meals: facts || {}, days: {} };
  } catch (error) {
    console.warn("[pdfMeals] extraction failed:", error.message);
    return { meals: {}, days: {} };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractPdfMeals(buffer) {
  const facts = await extractPdfFacts(buffer);
  return facts.meals || {};
}

export function applyMealMarks(trip, mealMap) {
  if (!trip?.days?.length || !mealMap || Object.keys(mealMap).length === 0) return trip;

  for (const day of trip.days) {
    const meals = mealMap[String(day.day)];
    if (meals) day.meals = meals;
  }

  return trip;
}

export function applyDayText(trip, dayMap) {
  if (!trip?.days?.length || !dayMap || Object.keys(dayMap).length === 0) return trip;

  for (const day of trip.days) {
    const extracted = dayMap[String(day.day)];
    if (!extracted) continue;
    if (extracted.route) day.route = extracted.route;
    if (extracted.summary && extracted.summary.length >= String(day.summary || "").length * 0.8) {
      day.summary = extracted.summary;
    }
    if (!day.summary && extracted.summary) day.summary = extracted.summary;
  }

  return trip;
}

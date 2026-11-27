/**
 * The agent's real outside world. Each piece is loaded on first use so importing the agent
 * (tests, the router) never needs the server environment, the database or the network.
 * All lookups here are reads.
 */
import { aiBudgetMessage, aiBudgetState } from "../aiUsage";
import { openAIToolChat } from "./openaiTools";
import type { AgentDeps, PosterPhotoView } from "./types";

const SHORT_LINK_TIMEOUT_MS = 5_000;

async function shortLinkLocation(url: string): Promise<string | null> {
  const parsed = new URL(url);
  // Only our own host is ever asked, and only for its redirect: the page behind it is not fetched here.
  if (parsed.protocol !== "https:" || !["uudamtravel.mn", "www.uudamtravel.mn"].includes(parsed.hostname)) return null;
  const response = await fetch(parsed.toString(), {
    method: "GET",
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(SHORT_LINK_TIMEOUT_MS),
    // A bot user-agent: the short-link app does not count the check as a visitor's click.
    headers: { "user-agent": "UudamAdminAssistant/1.0 (link check; bot)" },
  });
  const location = response.headers.get("location");
  return response.status >= 300 && response.status < 400 && location ? location : null;
}

async function slugToTripId(slug: string): Promise<string | null> {
  const { queryNeon } = await import("../neonDb");
  const result = await queryNeon<{ trip_id: string }>(
    "SELECT trip_id FROM trip_website_sync WHERE lower(website_slug) = lower($1) ORDER BY synced_at DESC NULLS LAST LIMIT 1",
    [slug],
  );
  return result?.rows?.[0]?.trip_id ?? null;
}

async function posterPhotos(posterId: string): Promise<PosterPhotoView | null> {
  const { queryNeon } = await import("../neonDb");
  // Only the hero and each day's photo: never the whole poster document. A poster day with no
  // route, summary or hotel is a photo-only slot, not a program day (tripPhotoEdit counts the same way).
  const result = await queryNeon<{ hero: string | null; days: Array<{ program: boolean; photo: unknown }> | null }>(
    `SELECT data->>'hero_image' AS hero,
            (SELECT jsonb_agg(jsonb_build_object(
                      'program', COALESCE(d->>'route', '') <> '' OR COALESCE(d->>'summary', '') <> '' OR COALESCE(d->>'hotel', '') <> '',
                      'photo', d->>'photo') ORDER BY n)
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'days') = 'array' THEN data->'days' ELSE '[]'::jsonb END) WITH ORDINALITY AS t(d, n)) AS days
       FROM poster_trips WHERE id = $1`,
    [posterId],
  );
  const row = result?.rows?.[0];
  if (!row) return null;
  const https = (value: unknown) => (typeof value === "string" && value.startsWith("https://") ? value : null);
  let programDay = 0;
  const days = (row.days || []).flatMap((entry) => (entry.program ? [{ day: (programDay += 1), photo: https(entry.photo) }] : []));
  return { hero: https(row.hero), days };
}

async function budget(): Promise<{ exceeded: boolean; message: string }> {
  const state = await aiBudgetState();
  return { exceeded: state.exceeded, message: state.exceeded ? aiBudgetMessage(state) : "" };
}

/**
 * Which model runs the assistant: OpenAI's gpt-4.1 by default; Claude with ASSISTANT_PROVIDER=anthropic
 * (and ANTHROPIC_API_KEY), its model from ASSISTANT_ANTHROPIC_MODEL (default claude-sonnet-5-5).
 */
export function assistantProvider(): "openai" | "anthropic" {
  return String(process.env.ASSISTANT_PROVIDER || "").trim().toLowerCase() === "anthropic" ? "anthropic" : "openai";
}

export function defaultAgentDeps(): AgentDeps {
  const anthropic = assistantProvider() === "anthropic";
  return {
    // Loaded only when chosen: the OpenAI path never imports the Anthropic SDK.
    chat: anthropic ? async (input) => (await import("./anthropicTools")).anthropicToolChat(input) : openAIToolChat,
    ...(anthropic ? { defaultModel: process.env.ASSISTANT_ANTHROPIC_MODEL?.trim() || "claude-sonnet-5-5", stableTools: true } : {}),
    safeFetch: async (url, options) => (await import("../safeFetch")).safeFetch(url, options),
    hostImage: async (source) => (await import("../websiteTripSync")).hostImage(source),
    shortLinkLocation,
    slugToTripId,
    posterPhotos,
    budget,
    now: () => Date.now(),
    describePhotos: async (urls) => (await import("./describePhotos")).describeHostedPhotos(urls),
    findPhotos: async (trip, catalogue, options) => {
      const [{ photosForSavedTrip }, { buildPhotoLibrary }] = await Promise.all([import("../tripProposalFinalize"), import("../tripPhotoLibrary")]);
      return photosForSavedTrip(trip, { library: buildPhotoLibrary(catalogue), web: options.web, photos: options.web ? { budgetMs: 50_000 } : undefined });
    },
  };
}

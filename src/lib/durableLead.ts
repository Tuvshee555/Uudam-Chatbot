import { createLead, hasRecentOpenLead } from "./travelLeadsDb";
import type { TravelLead } from "./travelTypes";
import { RetryableWebhookError } from "./webhookDedup";

/** A handoff is complete only after staff have a durable, unresolved lead. */
export async function ensureDurableLead(input: Parameters<typeof createLead>[0]): Promise<{
  created: boolean;
  lead: TravelLead | null;
}> {
  try {
    if (await hasRecentOpenLead(input.senderId, input.kind)) return { created: false, lead: null };
    const lead = await createLead(input);
    if (!lead) throw new Error("lead_not_persisted");
    return { created: true, lead };
  } catch (cause) {
    const error = new RetryableWebhookError(`lead_persistence_failed:${input.kind}`);
    error.cause = cause;
    throw error;
  }
}

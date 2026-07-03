import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTestEnv } from "./helpers/env";
import type { AIChangeProposal } from "../src/lib/travelTypes";

applyTestEnv();

async function loadTravelAI() {
  const { attachPhotoUrlsToActions } = await import("../src/lib/travelAI");
  return { attachPhotoUrlsToActions };
}

describe("travelAI photo attachment", () => {
  it("attaches source photos to a single action even when the model omitted photo_urls", async () => {
    const { attachPhotoUrlsToActions } = await loadTravelAI();
    const proposal: AIChangeProposal = {
      summary: "",
      needs_confirmation: false,
      important_reason: "",
      conflicts: [],
      actions: [
        {
          action: "upsert",
          fields: {
            operator_name: "UUDAM TRAVEL AGENCY",
            route_name: "Tokyo Fuji аялал",
          },
        },
      ],
    };

    attachPhotoUrlsToActions(
      new Map([["random-upload-name.jpg", ["https://example.com/tokyo.jpg"]]]),
      proposal,
    );

    assert.deepEqual(proposal.actions[0].fields?.photo_urls, [
      "https://example.com/tokyo.jpg",
    ]);
  });

  it("fuzzy matches zip photo labels to the right action and does not silently drop them", async () => {
    const { attachPhotoUrlsToActions } = await loadTravelAI();
    const proposal: AIChangeProposal = {
      summary: "",
      needs_confirmation: false,
      important_reason: "",
      conflicts: [],
      actions: [
        {
          action: "upsert",
          fields: {
            operator_name: "UUDAM TRAVEL AGENCY",
            route_name: "Бээжин Шанхай нислэгтэй аялал",
          },
        },
        {
          action: "upsert",
          fields: {
            operator_name: "UUDAM TRAVEL AGENCY",
            route_name: "Токио Фүжи аялал",
          },
        },
      ],
    };

    attachPhotoUrlsToActions(
      new Map([
        [
          "01-Бээжин-Шанхай-messenger-split-1.png.compressed.jpg",
          ["https://example.com/beijing-shanghai.jpg"],
        ],
      ]),
      proposal,
    );

    assert.deepEqual(proposal.actions[0].fields?.photo_urls, [
      "https://example.com/beijing-shanghai.jpg",
    ]);
    assert.equal(proposal.actions[1].fields?.photo_urls, undefined);
    assert.notEqual(
      proposal.conflict_items?.some((item) => item.type === "photo_unmatched"),
      true,
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTestEnv } from "./helpers/env";
import type { AIChangeProposal } from "../src/lib/travelTypes";

applyTestEnv();

async function loadTravelAI() {
  const { attachPhotoUrlsToActions, mergeDuplicateTripActions } = await import("../src/lib/travelAI");
  return { attachPhotoUrlsToActions, mergeDuplicateTripActions };
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

  it("leaves an equal sibling-trip match unassigned instead of choosing the first action", async () => {
    const { attachPhotoUrlsToActions } = await loadTravelAI();
    const proposal: AIChangeProposal = {
      summary: "",
      needs_confirmation: false,
      important_reason: "",
      conflicts: [],
      actions: [
        { action: "upsert", fields: { route_name: "Beidaihe ground tour" } },
        { action: "upsert", fields: { route_name: "Beidaihe flight tour" } },
      ],
    };

    attachPhotoUrlsToActions(
      new Map([["summer.zip/Beidaihe/1.jpg", ["https://example.com/unknown.jpg"]]]),
      proposal,
    );

    assert.equal(proposal.actions[0].fields?.photo_urls, undefined);
    assert.equal(proposal.actions[1].fields?.photo_urls, undefined);
    assert.equal(
      proposal.conflict_items?.some((item) => item.type === "photo_unmatched"),
      true,
    );
  });

  it("does not attach multiple ZIP trip folders to one action when extraction missed a trip", async () => {
    const { attachPhotoUrlsToActions } = await loadTravelAI();
    const proposal: AIChangeProposal = {
      summary: "",
      needs_confirmation: false,
      important_reason: "",
      conflicts: [],
      actions: [{ action: "upsert", fields: { route_name: "Unknown tour" } }],
    };

    attachPhotoUrlsToActions(
      new Map([
        ["summer.zip/Trip A/1.jpg", ["https://example.com/a.jpg"]],
        ["summer.zip/Trip B/1.jpg", ["https://example.com/b.jpg"]],
      ]),
      proposal,
    );

    assert.equal(proposal.actions[0].fields?.photo_urls, undefined);
    assert.equal(
      proposal.conflict_items?.filter((item) => item.type === "photo_unmatched").length,
      1,
    );
  });

  it("keeps transport variants as separate extracted trips", async () => {
    const { mergeDuplicateTripActions } = await loadTravelAI();
    const proposal: AIChangeProposal = {
      summary: "",
      needs_confirmation: false,
      important_reason: "",
      conflicts: [],
      actions: [
        { action: "upsert", fields: { route_name: "Beidaihe tour ground" } },
        { action: "upsert", fields: { route_name: "Beidaihe tour flight" } },
      ],
    };

    mergeDuplicateTripActions(proposal);

    assert.equal(proposal.actions.length, 2);
  });

  it("keeps different-duration products as separate extracted trips", async () => {
    const { mergeDuplicateTripActions } = await loadTravelAI();
    const proposal: AIChangeProposal = {
      summary: "",
      needs_confirmation: false,
      important_reason: "",
      conflicts: [],
      actions: [
        { action: "upsert", fields: { route_name: "Hailar tour", duration_text: "4 days" } },
        { action: "upsert", fields: { route_name: "Hailar tour", duration_text: "5 days" } },
      ],
    };

    mergeDuplicateTripActions(proposal);

    assert.equal(proposal.actions.length, 2);
  });

  it("merges same-route patch slices when only one slice has the resolved trip id", async () => {
    const { attachPhotoUrlsToActions, mergeDuplicateTripActions } = await loadTravelAI();
    const proposal: AIChangeProposal = {
      summary: "",
      needs_confirmation: false,
      important_reason: "",
      conflicts: [],
      actions: [
        {
          action: "patch",
          trip_id: "trip-shanghai-heaven",
          fields: {
            route_name: "Shanghai + Heaven Gate direct flight tour",
            adult_price: 3590000,
            departure_dates: ["June 27", "July 18", "August 8"],
            extra: {
              source_file_name:
                "Shanghai Heaven Gate-messenger-split.zip/Shanghai Heaven Gate-messenger-1.png.compressed.jpg",
            },
          },
        },
        {
          action: "patch",
          fields: {
            route_name: "Shanghai + Heaven Gate direct flight tour",
            notes: "Includes Shanghai Tower exterior view, temple, Disneyland optional, zoo optional, Nanjing road, Huangpu river Bund.",
            extra: {
              source_file_name:
                "Shanghai Heaven Gate-messenger-split.zip/Shanghai Heaven Gate-messenger-2.png.compressed.jpg",
            },
          },
        },
      ],
    };
    const photoUrls = new Map([
      [
        "Shanghai Heaven Gate-messenger-split.zip/Shanghai Heaven Gate-messenger-1.png.compressed.jpg",
        ["https://example.com/shanghai-1.jpg"],
      ],
      [
        "Shanghai Heaven Gate-messenger-split.zip/Shanghai Heaven Gate-messenger-2.png.compressed.jpg",
        ["https://example.com/shanghai-2.jpg"],
      ],
    ]);

    mergeDuplicateTripActions(proposal);
    attachPhotoUrlsToActions(photoUrls, proposal);

    assert.equal(proposal.actions.length, 1);
    assert.equal(proposal.actions[0].trip_id, "trip-shanghai-heaven");
    assert.equal(proposal.actions[0].fields?.adult_price, 3590000);
    assert.match(String(proposal.actions[0].fields?.notes || ""), /Disneyland/);
    assert.deepEqual(proposal.actions[0].fields?.photo_urls, [
      "https://example.com/shanghai-1.jpg",
      "https://example.com/shanghai-2.jpg",
    ]);
    assert.notEqual(
      proposal.conflict_items?.some((item) => item.type === "photo_unmatched"),
      true,
    );
  });

  it("merges incomplete itinerary fragments from a messenger-split poster into the parent trip", async () => {
    const { mergeDuplicateTripActions } = await loadTravelAI();
    const proposal: AIChangeProposal = {
      summary: "",
      needs_confirmation: false,
      important_reason: "",
      conflicts: [],
      actions: [
        {
          action: "upsert",
          fields: {
            route_name: "Chongqing ground flight combo",
            adult_price: 2390000,
            child_price: 2150000,
            departure_dates: ["July 19", "July 26"],
            extra: {
              source_file_name:
                "Chongqing ground flight combo-messenger-split.zip/Chongqing ground flight combo-messenger-1.png",
            },
          },
        },
        {
          action: "upsert",
          fields: {
            route_name: "Chongqing-Hohhot",
            duration_text: "8 days / 7 nights",
            has_food: true,
            extra: {
              route: "Chongqing-Hohhot",
              source_file_name:
                "Chongqing ground flight combo-messenger-split.zip/Chongqing ground flight combo-messenger-3.png",
            },
          },
        },
      ],
    };

    mergeDuplicateTripActions(proposal);

    assert.equal(proposal.actions.length, 1);
    assert.equal(proposal.actions[0].fields?.route_name, "Chongqing ground flight combo");
    assert.equal(proposal.actions[0].fields?.adult_price, 2390000);
  });

  it("keeps every messenger-split poster slice as photos on the surviving parent trip", async () => {
    const { attachPhotoUrlsToActions, mergeDuplicateTripActions } = await loadTravelAI();
    const proposal: AIChangeProposal = {
      summary: "",
      needs_confirmation: false,
      important_reason: "",
      conflicts: [],
      actions: [
        {
          action: "upsert",
          fields: {
            route_name: "Chongqing ground flight combo",
            adult_price: 2390000,
            child_price: 2150000,
            departure_dates: ["July 19", "July 26"],
            extra: {
              source_file_name:
                "Chongqing ground flight combo-messenger-split.zip/Chongqing ground flight combo-messenger-1.png",
            },
          },
        },
        {
          action: "upsert",
          fields: {
            route_name: "Chongqing-Hohhot",
            duration_text: "8 days / 7 nights",
            has_food: true,
            extra: {
              route: "Chongqing-Hohhot",
              source_file_name:
                "Chongqing ground flight combo-messenger-split.zip/Chongqing ground flight combo-messenger-3.png",
            },
          },
        },
      ],
    };
    const photoUrls = new Map([
      [
        "Chongqing ground flight combo-messenger-split.zip/Chongqing ground flight combo-messenger-1.png",
        ["https://example.com/chongqing-1.jpg"],
      ],
      [
        "Chongqing ground flight combo-messenger-split.zip/Chongqing ground flight combo-messenger-2.png",
        ["https://example.com/chongqing-2.jpg"],
      ],
      [
        "Chongqing ground flight combo-messenger-split.zip/Chongqing ground flight combo-messenger-3.png",
        ["https://example.com/chongqing-3.jpg"],
      ],
    ]);

    mergeDuplicateTripActions(proposal);
    attachPhotoUrlsToActions(photoUrls, proposal);

    assert.equal(proposal.actions.length, 1);
    assert.deepEqual(proposal.actions[0].fields?.photo_urls, [
      "https://example.com/chongqing-1.jpg",
      "https://example.com/chongqing-2.jpg",
      "https://example.com/chongqing-3.jpg",
    ]);
    assert.notEqual(
      proposal.conflict_items?.some((item) => item.type === "photo_unmatched"),
      true,
    );
  });
});

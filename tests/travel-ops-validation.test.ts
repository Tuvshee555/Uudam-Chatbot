import assert from "node:assert/strict";
import test from "node:test";
import type { AIChangeProposal } from "../src/lib/travelOps";
import { applyTestEnv } from "./helpers/env";

async function loadTravelOps() {
  applyTestEnv();
  return import("../src/lib/travelOps");
}

test("validation blocks patch actions without a target", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "patch",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [{ action: "patch", fields: { adult_price: 1000 } }],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.proposal.actions.length, 0);
  assert.equal(result.blocking_conflicts.length, 1);
  assert.equal(result.proposal.needs_confirmation, true);
});

test("validation marks suspicious child pricing for confirmation", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "upsert",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "Uudam",
          route_name: "Seoul tour",
          adult_price: 2000,
          child_price: 2500,
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, []);
  assert.equal(result.blocking_conflicts.length, 0);
  assert.equal(result.proposal.actions.length, 1);
  assert.equal(result.proposal.needs_confirmation, true);
  assert.match(result.proposal.conflicts.join(" "), /child price/i);
});

test("validation keeps uniquely matched upserts eligible", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "update existing",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        match: { operator_name: "Uudam", route_name: "Tokyo tour" },
        fields: { seats_left: 8 },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, [
    {
      id: "trip-1",
      operator_name: "Uudam",
      route_name: "Tokyo tour",
      status: "active",
      seats_left: 10,
      seats_total: 20,
      adult_price: 5000000,
      child_price: 4500000,
      currency: "MNT",
    },
  ]);

  assert.equal(result.blocking_conflicts.length, 0);
  assert.equal(result.proposal.actions.length, 1);
  assert.equal(result.auto_apply_ready, true);
});

test("validation warns before duplicate upsert creation", async () => {
  const { validateAIChangeProposal } = await loadTravelOps();
  const proposal: AIChangeProposal = {
    summary: "new trip",
    needs_confirmation: false,
    important_reason: "",
    conflicts: [],
    actions: [
      {
        action: "upsert",
        fields: {
          operator_name: "Uudam",
          route_name: "Beijing tour",
          adult_price: 3000000,
        },
      },
    ],
  };

  const result = validateAIChangeProposal(proposal, [
    {
      id: "trip-2",
      operator_name: "Uudam",
      route_name: "Beijing tour",
      status: "active",
      seats_left: 12,
      seats_total: 20,
      adult_price: 2900000,
      child_price: 2500000,
      currency: "MNT",
    },
  ]);

  assert.equal(result.blocking_conflicts.length, 0);
  assert.equal(result.proposal.needs_confirmation, true);
  assert.equal(result.auto_apply_ready, false);
  assert.match(result.proposal.conflicts.join(" "), /duplicate/i);
});

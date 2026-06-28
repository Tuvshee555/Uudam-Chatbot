import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTestEnv } from "./helpers/env";
import {
  extractSequencePrefix,
  normalizeFilenameForMatch,
  normalizeTripName,
  tokenCoverageScore,
} from "../src/lib/tripPhotoImport/normalize";

before(() => applyTestEnv());

describe("tripPhotoImport normalize", () => {
  it("normalizes case and punctuation", () => {
    assert.equal(normalizeTripName("ШАР ТЭНГИС БУЮУ БЭЙДАЙХЭ!"), "шар тэнгис буюу бэйдайхэ");
  });

  it("treats hyphen, em-dash, and minus sign as spaces", () => {
    assert.equal(
      normalizeTripName("ШАР ТЭНГИС–БЭЙДЭХЭ+БЭЭЖИНГИЙН ГАЗАР"),
      "шар тэнгис бэйдэхэ бээжингийн газар",
    );
  });

  it("normalizes filenames with sequence markers", () => {
    assert.equal(
      normalizeFilenameForMatch("01-ШАР ТЭНГИС-БЭЙДЭХЭ.jpg"),
      "шар тэнгис бэйдэхэ",
    );
  });

  it("extracts sequence prefixes", () => {
    assert.equal(extractSequencePrefix("02-Name.jpg"), 2);
    assert.equal(extractSequencePrefix("Name-10.jpg"), 10);
    assert.equal(extractSequencePrefix("Name.jpg"), undefined);
  });

  it("computes token coverage between similar names", () => {
    const score = tokenCoverageScore(
      "УБ-Датун-Утай шууд нислэг",
      "Датан Утай шууд нислэг",
    );
    assert.ok(score > 0.4);
  });
});

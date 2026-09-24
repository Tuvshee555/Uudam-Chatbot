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
    assert.equal(normalizeTripName("СЭРВЭН ТЭНГИС БУЮУ КАРДАН!"), "сэрвэн тэнгис буюу кардан");
  });

  it("treats hyphen, em-dash, and minus sign as spaces", () => {
    assert.equal(
      normalizeTripName("СЭРВЭН ТЭНГИС–КАРДЭН+ВЭЛМОРГИЙН ГАЗАР"),
      "сэрвэн тэнгис кардэн вэлморгийн газар",
    );
  });

  it("normalizes filenames with sequence markers", () => {
    assert.equal(
      normalizeFilenameForMatch("01-СЭРВЭН ТЭНГИС-КАРДЭН.jpg"),
      "сэрвэн тэнгис кардэн",
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

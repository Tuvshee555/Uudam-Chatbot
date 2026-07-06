import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

async function loadExtractors() {
  const { buildImportItemsFromRawFiles } = await import(
    "../src/lib/tripPhotoImport/extract"
  );
  return { buildImportItemsFromRawFiles };
}

describe("tripPhotoImport extract", () => {
  it("groups sibling trip folders when a parent folder is selected", async () => {
    const { buildImportItemsFromRawFiles } = await loadExtractors();
    const result = await buildImportItemsFromRawFiles([
      {
        fieldName: "files",
        fileName: "Naadmiin-aylaluud-14/Trip A/1.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from("a"),
      },
      {
        fieldName: "files",
        fileName: "Naadmiin-aylaluud-14/Trip A/2.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from("b"),
      },
      {
        fieldName: "files",
        fileName: "Naadmiin-aylaluud-14/Trip B/1.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from("c"),
      },
    ]);

    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].sourceType, "folder");
    assert.equal(result.items[0].name, "Trip A");
    assert.equal(result.items[0].imageCount, 2);
    assert.equal(result.items[1].name, "Trip B");
    assert.equal(result.items[1].imageCount, 1);
  });

  it("keeps a single selected trip folder together", async () => {
    const { buildImportItemsFromRawFiles } = await loadExtractors();
    const result = await buildImportItemsFromRawFiles([
      {
        fieldName: "files",
        fileName: "Trip Solo/1.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from("a"),
      },
      {
        fieldName: "files",
        fileName: "Trip Solo/2.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from("b"),
      },
    ]);

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].sourceType, "folder");
    assert.equal(result.items[0].name, "Trip Solo");
    assert.equal(result.items[0].imageCount, 2);
  });
});

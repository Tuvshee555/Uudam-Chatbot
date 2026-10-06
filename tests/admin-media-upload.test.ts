import assert from "node:assert/strict";
import test from "node:test";
import { uploadAdminMedia } from "../src/lib/adminMediaUpload";

const signed = async () => Response.json({ cloudName: "test-cloud", apiKey: "test-key", timestamp: 1, signature: "test-signature", folder: "test" });

test("hotel image and video upload use the signed API and the correct resource endpoint", async () => {
  for (const kind of ["image", "video"]) {
    const file = new File(["test"], kind === "image" ? "hotel.jpg" : "hotel.mp4", { type: kind === "image" ? "image/jpeg" : "video/mp4" });
    let calls = 0;
    const url = await uploadAdminMedia(file, async (path, init) => {
      assert.equal(path, "/api/admin/upload-image");
      assert.equal(init?.method, "POST");
      return signed();
    }, (async (path, init) => {
      calls++;
      assert.equal(path, `https://api.cloudinary.com/v1_1/test-cloud/${kind}/upload`);
      assert.equal((init?.body as FormData).get("signature"), "test-signature");
      assert.equal((init?.body as FormData).get("folder"), "test");
      return Response.json({ secure_url: `https://example.com/hotel.${kind}` });
    }) as typeof fetch);
    assert.equal(calls, 1);
    assert.equal(url, `https://example.com/hotel.${kind}`);
  }
});

test("invalid files and missing upload configuration fail without uploading", async () => {
  await assert.rejects(uploadAdminMedia(new File(["test"], "data.txt", { type: "text/plain" }), signed), /Зураг эсвэл бичлэг/);
  await assert.rejects(uploadAdminMedia(new File(["test"], "hotel.jpg", { type: "image/jpeg" }), async () => new Response(null, { status: 503 })), /тохиргоог/);
});

test("failed upload and missing secure URL never produce a saved media URL", async () => {
  const file = new File(["test"], "hotel.jpg", { type: "image/jpeg" });
  await assert.rejects(uploadAdminMedia(file, signed, (async () => new Response(null, { status: 400 })) as typeof fetch), /байршуулж чадсангүй/);
  await assert.rejects(uploadAdminMedia(file, signed, (async () => Response.json({ url: "http://example.com/hotel.jpg" })) as typeof fetch), /холбоос ирсэнгүй/);
});

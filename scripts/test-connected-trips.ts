import { loadEnvConfig } from "@next/env";
import { parseEnv } from "node:util";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { Pool } from "pg";
loadEnvConfig(process.cwd());
process.env.BOOKING_DATABASE_URL ||= parseEnv(readFileSync("../uudam-booking-web/.env","utf8")).DATABASE_URL;
process.env.SITE_URL ||= "https://uudam-chatbot.vercel.app";

async function main() {
  const { upsertTrip, patchTrip, deleteTrip } = await import("../src/lib/travelDb");
  const { savePosterTrip, getPosterTrip, deletePosterTrip } = await import("../src/lib/poster/db");
  const { queryNeon, closeNeonPool } = await import("../src/lib/neonDb");
  const { flushWebsiteSync, closeBookingPool } = await import("../src/lib/websiteTripSync");
  const url=new URL(process.env.BOOKING_DATABASE_URL!); url.searchParams.set("sslmode","verify-full");
  const web=new Pool({connectionString:url.toString()});
  const id=`sync-test-${randomUUID()}`;
  const posterId=`poster-for-${id}`;
  const config=process.env.BOOKING_DATABASE_URL;
  const lookup=async()=> (await web.query(`SELECT * FROM "Trip" WHERE "sourceTripId"=$1`,[id])).rows;
  try {
    const created=await upsertTrip({id,fields:{route_name:"Холболтын түр шалгалт",status:"draft",adult_price:1230000,
      duration_text:"3 өдөр 2 шөнө",departure_dates:["2026-10-17"],photo_urls:[],
      extra:{customer_visible:false,included_items:["Зочид буудал"],itinerary_days:[{day:1,title:"Өдөр нэг",description:"Шалгалтын хөтөлбөр"}]}}});
    assert.equal(created?.extra.poster_trip_id,posterId);
    assert.ok(await getPosterTrip(posterId));
    let rows=await lookup();
    assert.equal(rows.length,1);
    const websiteId=rows[0].id;
    assert.equal(rows[0].isPublished,false);
    assert.equal(rows[0].price,1230000);
    assert.match(rows[0].brochurePdfUrl,/api\/poster-pdf/);
    const poster=await getPosterTrip(posterId);
    await savePosterTrip({id:posterId,title:"Шинэчилсэн постер",data:{...poster?.data as object,title:"Шинэчилсэн постер",
      departures:[{date:"2026-10-19"}],days:[{day:1,route:"Шинэ өдөр",summary:"Бүрэн хөтөлбөр",photo:null}],
      price_table:{columns:["Том хүн","Хүүхэд"],rows:[{dates:"2026-10-19",cells:["1,500,000₮","900,000₮"]}]}}});
    rows=await lookup();
    assert.equal(rows.length,1); assert.equal(rows[0].id,websiteId); assert.equal(rows[0].price,1500000);
    assert.equal(rows[0].title,"Шинэчилсэн постер");
    await patchTrip(id,{status:"sold_out"});
    assert.equal((await web.query(`SELECT status FROM "Departure" WHERE "tripId"=$1`,[websiteId])).rows[0].status,"SOLD_OUT");
    await patchTrip(id,{status:"active"});
    assert.equal((await web.query(`SELECT status FROM "Departure" WHERE "tripId"=$1`,[websiteId])).rows[0].status,"OPEN");
    assert.equal((await lookup())[0].isPublished,false);
    await Promise.all([patchTrip(id,{notes:"Notes"}),patchTrip(id,{hotel:"Hotel"})]);
    assert.equal((await lookup()).length,1);
    const styledPoster=await getPosterTrip(posterId);
    await savePosterTrip({id:posterId,title:styledPoster!.title,data:{...styledPoster!.data as object,style:{photoScale:0.5}}});
    rows=await lookup(); assert.equal(rows[0].hotel,"Hotel"); assert.equal(rows[0].isPublished,false);
    delete process.env.BOOKING_DATABASE_URL;
    await patchTrip(id,{route_name:"Retry verification"});
    const failed=await queryNeon("SELECT * FROM trip_website_sync WHERE trip_id=$1",[id]);
    assert.ok(failed?.rows[0].last_error);
    process.env.BOOKING_DATABASE_URL=config;
    await flushWebsiteSync(id,1);
    rows=await lookup(); assert.equal(rows[0].title,"Retry verification"); assert.equal(rows[0].id,websiteId);
    await flushWebsiteSync(id,1); assert.equal((await lookup()).length,1);
    if(process.argv.includes("--pdf")) {
      const { renderPosterPdf }=await import("../src/lib/poster/renderPdf");
      const current=await getPosterTrip(posterId); assert.ok(current);
      const pdf=await renderPosterPdf(current);
      assert.equal(pdf.subarray(0,4).toString(),"%PDF");
      mkdirSync("tmp/pdfs",{recursive:true}); writeFileSync("tmp/pdfs/connected-trip-test.pdf",pdf);
      console.log(`PDF verified: ${pdf.length} bytes`);
    }
    assert.ok(await deletePosterTrip(posterId));
    assert.equal((await lookup()).length,0);
    assert.equal((await queryNeon("SELECT id FROM travel_trip_entries WHERE id=$1",[id]))?.rows.length,0);
    console.log("PASS: chatbot creation, reverse poster, poster edits, stable website ID, concurrent edits, retry, replay, linked deletion");
  } finally {
    process.env.BOOKING_DATABASE_URL=config;
    await deleteTrip(id);
    await queryNeon("DELETE FROM trip_website_sync WHERE trip_id=$1",[id]);
    await web.end(); await closeBookingPool(); await closeNeonPool();
  }
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});

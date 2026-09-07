import test from "node:test";
import assert from "node:assert/strict";
import { tripToPoster, websiteDepartures, posterPhotos } from "../src/lib/connectedTripMapping";
import type { TravelTrip } from "../src/lib/travelTypes";
import { normalizeExtraPatch } from "../src/lib/tripExtraSchema";

const trip: TravelTrip = { id:"fixture",route_name:"Trip",operator_name:"Uudam",category:"",duration_text:"3 өдөр 2 шөнө",
  adult_price:1230000,child_price:990000,currency:"MNT",departure_dates:["2026-09-17"],seats_total:null,seats_left:null,
  has_food:null,status:"draft",notes:"",hotel:"",source_description:"",photo_urls:[],extra:{},created_at:"",updated_at:"" };
test("renaming preserves poster photos, layout and departure-specific price table", () => {
  const prior={ title:"Trip",style:{photoScale:0.5},days:[{day:1,photo:"https://example.com/photo.jpg"}],price_table:{rows:[{cells:["100"]},{cells:["200"]}]} };
  const result=tripToPoster({...trip,route_name:"Renamed"},prior,trip);
  assert.equal(result.title,"Renamed");
  assert.deepEqual(result.days,prior.days);
  assert.deepEqual(result.price_table,prior.price_table);
  assert.deepEqual(result.style,prior.style);
});
test("photo removal clears gallery slots while retaining day descriptions", () => {
  const result=tripToPoster(trip,{days:[{day:1,summary:"Day one",photo:"https://example.com/a.jpg"}]},{...trip,photo_urls:["https://example.com/a.jpg"]});
  assert.deepEqual(posterPhotos(result),[]);
  assert.equal((result.days as {summary:string}[])[0].summary,"Day one");
});
test("departure parser never turns null or invalid dates into epoch dates", () => {
  const result=websiteDepartures({...trip,extra:{departure_dates_resolved:[{ymd:null},{ymd:"2026-02-31"},{ymd:"2026-09-17"},{ymd:"2026-09-17"}]} });
  assert.equal(result.length,1);
  assert.equal(result[0].start,"2026-09-17T00:00:00.000Z");
  assert.equal(result[0].end,"2026-09-19T00:00:00.000Z");
});
test("weekly rules are explicit and respect Mongolian calendar dates", () => {
  const recurring=websiteDepartures({...trip,departure_dates:["Пүрэв гараг бүр"]},new Date("2026-09-09T23:00:00Z"));
  assert.equal(recurring.length,12);
  assert.equal(recurring[0].start,"2026-09-10T00:00:00.000Z");
  assert.deepEqual(websiteDepartures({...trip,departure_dates:["Хугацаа тодорхойгүй"]}),[]);
});
test("website departures inherit date-specific price group overrides", () => {
  const result=websiteDepartures({...trip,extra:{
    departure_dates_resolved:[
      {text:"8 сарын 17",ymd:"2026-08-17"},
      {text:"8 сарын 24",ymd:"2026-08-24"},
    ],
    price_groups:[
      {dates:["8 сарын 17"],adult_price:990000,child_price:890000,infant_price:390000},
      {dates:["8 сарын 24"],adult_price:1190000,child_price:990000,infant_price:390000},
    ],
  }},new Date("2026-07-16T04:00:00.000Z"));
  assert.equal(result.length,2);
  assert.equal(result[0].price,990000);
  assert.equal(result[0].childPrice,890000);
  assert.equal(result[1].price,1190000);
  assert.equal(result[1].childPrice,990000);
});
test("partial metadata updates preserve visibility, prices and unrelated details", () => {
  const existing = {customer_visible:false,price_groups:[{adult_price:123}],included_items:["Hotel"],departure_rule:"Weekly"};
  const patch = normalizeExtraPatch({included_items:[],website_sync:{synced:true}});
  assert.deepEqual({...existing,...patch},{...existing,included_items:[]});
  assert.deepEqual(normalizeExtraPatch({customer_visible:false}),{customer_visible:false});
  assert.deepEqual(normalizeExtraPatch({}),{});
});

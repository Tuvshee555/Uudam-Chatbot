import { closeNeonPool } from "../src/lib/neonDb";
import { closeBookingPool } from "../src/lib/websiteTripSync";
import { importSourceTrip, type SourceTripImport } from "./lib/sourceTripImporter";

const trips: SourceTripImport[] = [
  {
    posterId: "poster-global-bangkok-pattaya-2026-11-18",
    title: "БАНГКОК - ПАТТАЯА АЯЛАЛ",
    sourceUrl: "https://global-travel.mn/tours/%D1%82%D0%B0%D0%B9%D0%BB%D0%B0%D0%BD%D0%B4-%D0%B0%D1%8F%D0%BB%D0%B0%D0%BB",
    operator: "Global Travel Corporation",
    durationText: "8 өдөр 7 шөнө",
    dates: ["2026-11-18"],
    adultPrice: 4_390_000,
    childPrice: null,
    infantPrice: null,
    hotel: "Бангкок / Паттаяа хотын зочид буудал",
    photoQueries: [
      "Bangkok Grand Palace Thailand",
      "Wat Arun Bangkok",
      "Pattaya beach Thailand",
      "Sanctuary of Truth Pattaya",
      "Nong Nooch Tropical Garden Pattaya",
      "Coral Island Pattaya",
      "Chao Phraya River Bangkok",
      "Bangkok skyline Thailand",
    ],
    days: [
      { title: "Улаанбаатар - Бангкок", description: "Улаанбаатараас Тайланд руу нисэж, Бангкок хотод хүрэлцэн ирээд буудалдаа байрлана." },
      { title: "Бангкок хотын аялал", description: "Бангкок хотын соёлын дурсгалт газрууд, сүм хийд болон хотын үзэмжтэй танилцана." },
      { title: "Бангкок - Паттаяа", description: "Паттаяа чиглэлд аялж, далайн эргийн амралтын уур амьсгалыг мэдэрнэ." },
      { title: "Паттаяа далайн эрэг", description: "Далайн эрэг дээр амрах, нэмэлт үзвэр үйлчилгээ сонгох чөлөөт өдөр." },
      { title: "Арал болон далайн аялал", description: "Паттаяагийн ойролцоох арал, далайн аяллын хөтөлбөртэй өдөр." },
      { title: "Нонг Нүч цэцэрлэгт хүрээлэн", description: "Тайландын халуун орны цэцэрлэгт хүрээлэн, амралтын бүсээр аялна." },
      { title: "Паттаяа - Бангкок", description: "Бангкок руу буцаж, худалдаа болон чөлөөт цагтай." },
      { title: "Бангкок - Улаанбаатар", description: "Аяллаа өндөрлөн Улаанбаатар руу буцна." },
    ],
    reviewReasons: ["Global Travel page exposed metadata/date/price, but not full day-by-day itinerary in readable page data."],
  },
  {
    posterId: "poster-global-egypt-direct-flight-2026-12-05",
    title: "ЕГИПЕТ шууд нислэгтэй аялал",
    sourceUrl: "https://global-travel.mn/tours/%D0%B5%D0%B3%D0%B8%D0%BF%D0%B5%D1%82",
    operator: "Global Travel Corporation",
    durationText: "7 өдөр 6 шөнө",
    dates: ["2026-12-05"],
    adultPrice: null,
    childPrice: null,
    infantPrice: null,
    hotel: "Египет аяллын зочид буудал",
    photoQueries: [
      "Giza pyramids Egypt",
      "Sphinx Giza Egypt",
      "Cairo Nile river",
      "Egyptian Museum Cairo",
      "Sharm El Sheikh beach",
      "Red Sea Egypt coral reef",
      "Luxor temple Egypt",
      "Khan el Khalili Cairo",
    ],
    days: [
      { title: "Улаанбаатар - Египет", description: "Улаанбаатараас Египет рүү шууд нислэгээр аялж, буудалдаа байрлана." },
      { title: "Каир хот", description: "Каир хотын түүх, соёлын гол үзмэрүүдтэй танилцана." },
      { title: "Гиза пирамид - Сфинкс", description: "Гиза пирамид, Сфинкс болон Египетийн эртний соёлын дурсгалуудыг үзнэ." },
      { title: "Нил мөрөн - музей", description: "Нил мөрний орчин болон Египетийн музейн аяллын хөтөлбөртэй." },
      { title: "Улаан тэнгисийн амралт", description: "Шарм эл Шейх эсвэл Улаан тэнгисийн амралтын бүсийн уур амьсгалыг мэдэрнэ." },
      { title: "Чөлөөт өдөр", description: "Далайн эрэг, нэмэлт аялал, худалдаа эсвэл өөрийн сонирхлоор чөлөөт цагтай." },
      { title: "Египет - Улаанбаатар", description: "Аяллаа өндөрлөн Улаанбаатар руу буцна." },
    ],
    reviewReasons: ["Global Travel page exposed metadata/date but no source price and no full day-by-day itinerary in readable page data."],
  },
];

async function main() {
  for (const trip of trips) {
    console.log(`\n=== ${trip.title} ===`);
    const result = await importSourceTrip(trip);
    console.log(`saved ${result.tripId} photos=${result.photos.length}`);
  }
}

main()
  .finally(async () => {
    await closeBookingPool();
    await closeNeonPool();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

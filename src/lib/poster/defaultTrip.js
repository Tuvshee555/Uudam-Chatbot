/**
 * Blank starting point for the poster editor ("Default template" button) — it is
 * NOT a real trip and must never look like one.
 *
 * It used to carry a real route name and real catalog fares, so a staff member
 * who started from the template, swapped the photos and exported would publish
 * a poster quoting a real-looking price for the wrong trip. (The offending
 * values are deliberately not repeated here — naming them would put live
 * catalog data back into the file this comment exists to keep clean.)
 *
 * Every identifying value here is now an obvious placeholder — including the
 * day-by-day route, which still named real border crossings and cities. The
 * shape still teaches the editor, but nothing can be mistaken for a genuine
 * offer, and nothing goes stale when the catalog changes.
 *
 * Real trip data always comes from the DB catalog — never from this file.
 */
export function createDefaultTrip() {
  return {
    agency: "UUDAM TRAVEL AGENCY",
    title: "[АЯЛЛЫН НЭР]",
    subtitle: "[Дэд гарчиг]",
    duration_days: 6,
    duration_nights: 5,
    hero_image: null,
    flights: null,
    departures: [
      { date: "[огноо 1]" },
      { date: "[огноо 2]" },
      { date: "[огноо 3]" },
    ],
    price_table: {
      columns: ["Том хүн", "Хүүхэд"],
      rows: [
        { dates: "[1-р хугацаа]", cells: ["1,111,111₮", "999,999₮"] },
        { dates: "[2-р хугацаа]", cells: ["2,222,222₮", "999,999₮"] },
      ],
      note: "",
    },
    price_note: "",
    price_desc: "",
    days: [
      {
        day: 1,
        route: "УБ → [Хилийн боомт] → [Хот 1]",
        distance_km: 0,
        summary:
          "Аяллын эхний өдөр аялагчид Улаанбаатараас хөдөлж, хилийн боомтоор дамжин нэвтрээд [Хот 1] хотод хүрнэ. Замын турш аяллын багийн зааварчилгаа авч, тухайн өдрийн хэмнэлд тайван дасах боломжтой.",
        activities: ["Улаанбаатараас хөдөлнө", "Хилийн боомтоор нэвтэрнэ", "[Хот 1] хотод байрлана"],
        meals: { breakfast: false, lunch: false, dinner: true },
        hotel: "[Буудлын нэр]",
        flight: null,
        bonus: [],
        photo: null,
        photo_caption: "",
      },
      {
        day: 2,
        route: "[Хот 1] → [Хот 2]",
        distance_km: 0,
        summary:
          "Өглөөний цайны дараа далайн эргийн амралтын бүс болох [Хот 2] чиглэлд хөдөлнө. Очсоны дараа буудалдаа байрлаж, далайн салхи, амралтын хотын тайван уур амьсгалыг мэдэрнэ.",
        activities: ["[Хот 2] чиглэлд хөдөлнө", "Буудалдаа байрлана", "Далайн эргээр чөлөөтэй алхана"],
        meals: { breakfast: true, lunch: false, dinner: true },
        hotel: "[Буудлын нэр]",
        flight: null,
        bonus: [],
        photo: null,
        photo_caption: "",
      },
      {
        day: 3,
        route: "[Хот 2]",
        distance_km: 0,
        summary:
          "Энэ өдөр далайн эргийн чөлөөт амралтад зориулагдана. Аялагчид далайн эргээр зугаалж, зураг авах, усан орчинд амрах, гэр бүлээрээ тайван өнгөрүүлэх боломжтой.",
        activities: ["Далайн эргээр амарна", "Чөлөөт зураг авалт хийнэ", "Орой буудалдаа амарна"],
        meals: { breakfast: true, lunch: false, dinner: true },
        hotel: "[Буудлын нэр]",
        flight: null,
        bonus: [],
        photo: null,
        photo_caption: "",
      },
    ],
    includes: [],
    excludes: [],
    contacts: {
      phones: ["7713 6633", "8913 6633", "9117 2769", "9924 8000"],
      email: "uudamtravel6@gmail.com",
      address: 'Чингэлтэй дүүрэг, 4-р хороо, Анхарагийн гудамж-23, "Todtower" офис, 701 тоот',
    },
  };
}

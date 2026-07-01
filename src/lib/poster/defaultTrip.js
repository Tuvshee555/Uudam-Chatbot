export function createDefaultTrip() {
  return {
    agency: "UUDAM TRAVEL AGENCY",
    title: "БЭЙДАХЭ АЯЛАЛ",
    subtitle: "Шар тэнгисийн аялал",
    duration_days: 6,
    duration_nights: 5,
    hero_image: null,
    flights: null,
    departures: [
      { date: "7-р сарын 4" },
      { date: "7-р сарын 11" },
      { date: "7-р сарын 18" },
    ],
    price_table: {
      columns: ["Том хүн", "Хүүхэд"],
      rows: [
        { dates: "7-р сар", cells: ["2,340,000₮", "1,950,000₮"] },
        { dates: "8-р сар", cells: ["2,660,000₮", "2,260,000₮"] },
      ],
      note: "",
    },
    price_note: "",
    price_desc: "",
    days: [
      {
        day: 1,
        route: "УБ → Замын-Үүд → Эрээн",
        distance_km: 0,
        summary:
          "Аяллын эхний өдөр аялагчид Улаанбаатараас хөдөлж, Замын-Үүдээр дамжин хил нэвтрээд Эрээн хотод хүрнэ. Замын турш аяллын багийн зааварчилгаа авч, тухайн өдрийн хэмнэлд тайван дасах боломжтой.",
        activities: ["Улаанбаатараас хөдөлнө", "Замын-Үүдээр дамжин хил нэвтэрнэ", "Эрээн хотод байрлана"],
        meals: { breakfast: false, lunch: false, dinner: true },
        hotel: "Эрээн хотын зочид буудал",
        flight: null,
        bonus: [],
        photo: null,
        photo_caption: "",
      },
      {
        day: 2,
        route: "Эрээн → Бэйдахэ",
        distance_km: 0,
        summary:
          "Өглөөний цайны дараа далайн эргийн амралтын бүс болох Бэйдахэ чиглэлд хөдөлнө. Очсоны дараа буудалдаа байрлаж, далайн салхи, амралтын хотын тайван уур амьсгалыг мэдэрнэ.",
        activities: ["Бэйдахэ чиглэлд хөдөлнө", "Буудалдаа байрлана", "Далайн эргээр чөлөөтэй алхана"],
        meals: { breakfast: true, lunch: false, dinner: true },
        hotel: "Бэйдахэ далайн эргийн буудал",
        flight: null,
        bonus: [],
        photo: null,
        photo_caption: "",
      },
      {
        day: 3,
        route: "Бэйдахэ",
        distance_km: 0,
        summary:
          "Энэ өдөр далайн эргийн чөлөөт амралтад зориулагдана. Аялагчид далайн эргээр зугаалж, зураг авах, усан орчинд амрах, гэр бүлээрээ тайван өнгөрүүлэх боломжтой.",
        activities: ["Далайн эргээр амарна", "Чөлөөт зураг авалт хийнэ", "Орой буудалдаа амарна"],
        meals: { breakfast: true, lunch: false, dinner: true },
        hotel: "Бэйдахэ далайн эргийн буудал",
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

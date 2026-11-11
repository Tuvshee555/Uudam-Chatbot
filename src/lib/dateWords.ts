/**
 * Date and party words that carry no destination: what a customer types around a month, a
 * holiday, a head count. DATE_FOLLOWUP_WORDS is the set for a BARE date follow-up (fastPathRouting
 * dateFollowup); CALENDAR_FOLLOWUP_WORDS is the wider set the place judgement treats as "not a
 * place" (placeLikeTokens.ts). Neither one decides alone whether a message is a new destination.
 */

export const DATE_FOLLOWUP_WORDS = new Set([
  "оны", "он", "сарын", "сар", "нд", "д", "ны", "ний", "нь", "ni", "nii", "nd", "sariin", "sar",
  "өнөөдөр", "маргааш", "нөгөөдөр", "today", "tomorrow", "margaash", "margash", "nuguudur",
  "аялал", "аяллын", "aylal", "aylaliin", "үнэ", "une", "vne", "хэд", "хэдэн", "hed", "heden",
  "вэ", "ве", "ve", "байна", "байгаа", "бол", "уу", "юу", "uu", "yu", "бну", "бна", "bnu", "bna", "baina",
  // Phone typing: "11 sard bn", "11.04нийг сонирхож бна" (accusative -ийг).
  "bn", "bnuu", "bgayu", "бнуу", "бга", "бгаа", "бгаюу", "нийг", "ыг", "ийг", "sarin", "saryn", "sarun",
  "гарах", "явах", "garah", "yavah", "yvah", "хөтөлбөр", "үзэх", "hutulbur", "uzey", "uzye",
]);

export const CALENDAR_FOLLOWUP_WORDS = new Set([
  ...DATE_FOLLOWUP_WORDS, "сард", "сарынх", "сарых", "sard", "sariinh", "р", "r", "дугаар", "дахь", "дэх",
  "эхний", "эхээр", "эхэнд", "сүүлийн", "сүүлчийн", "сүүлээр", "дунд", "дундуур", "долоо", "хоног", "хоногт", "хоногийн", "хооронд",
  "ehnii", "eheer", "ehend", "suuliin", "suuleer", "dund", "doloo", "honog", "hoorond",
  // "1 сарын 20доор" = around the 20th.
  "доор", "door", "орчим", "orchim",
  "сонирхож", "sonirhoj", "болох", "боломжтой", "суудал", "suudal", "bga", "bgaa", "baigaa",
  "шууд", "нислэгтэй", "нислэг", "shuud", "nislegtei", "nisleg", "хэдээр", "үнэтэй", "price", "cost",
  "нэг", "хоёр", "гурав", "дөрөв", "тав", "зургаа", "долоо", "найм", "ес", "арав", "арван",
  // The same month numbers typed in Latin: "neg sard" read as a new destination and got silence (live 2026-10-30).
  "neg", "nig", "tav", "hoyor", "hoyr", "hoer", "gurav", "guraw", "dorov", "duruv", "taw", "zurgaa", "naim", "yes", "yos", "arav", "araw", "arvan",
  // Who travels is not a new destination: "12/20 nd 2 hun", "11/4-нд 3 хүн", "2 том хүн 1 хүүхэд".
  "хүн", "хүний", "hun", "huun", "humuus", "том", "tom", "хүүхэд", "хүүхдийн", "huuhed", "huuhdiin", "нярай", "nyarai",
  // A start-date constraint is not a destination either: "Хүүхдийн амралт 11.1-с эхлэх гээд бдаг...яах вэ".
  "с", "аас", "ээс", "оос", "өөс", "хойш", "хойшоо", "эхлэх", "эхлэн", "эхэлнэ", "эхэлдэг", "эхлэхээр", "hoish", "ehleh", "ehlen",
  "амралт", "амралтаар", "амралтанд", "amralt", "сургууль", "хичээл", "гээд", "geed", "бдаг", "байдаг", "bdag", "яах", "yah",
  // "Цагаан сараар хэдэнд гарах вэ" (on which days): a time question about the trips on screen.
  "хэдэнд", "хэдний", "hedend", "hedenii", "хэзээ", "hezee",
]);


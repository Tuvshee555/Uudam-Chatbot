/** Instructions staff paste into ChatGPT alongside the trip JSON export, from the admin JSON editor tab. */
export const GPT_PROMPT =
  `Доорх JSON нь манай аялалын компанийн бүх аяллын жагсаалт. Та дараах зүйлийг хийнэ үү:

1. Аялал бүрт "price_groups" талбарыг нэм. Хэрэв аялал огноо тус бүрт өөр өөр үнэтэй бол тус тусад нь бич. Жишээ:
   "price_groups": [
     { "label": "6 сарын үнэ", "dates": ["6 сарын 27"], "adult_price": 3590000, "child_price": 3260000, "infant_price": null, "child_age": "2-12 нас", "infant_age": "0-2 нас", "note": "" },
     { "label": "7/8 сарын үнэ", "dates": ["7 сарын 18", "8 сарын 8"], "adult_price": 3660000, "child_price": 3260000, "infant_price": null, "child_age": "2-12 нас", "infant_age": "0-2 нас", "note": "" }
   ]

2. Аялал бүрт "discounts" талбарыг нэм (хямдрал байвал). Жишээ:
   "discounts": [
     { "label": "Эрт захиалгын хямдрал", "dates": [], "adult_price": 2550000, "child_price": 2250000, "infant_price": null, "condition": "7 хоногийн өмнө захиалбал", "note": "" }
   ]

3. Аялал бүрт "aliases" талбарыг нэм — хэрэглэгчид хэрхэн хайдаг болохыг бод. Жишээ:
   "aliases": ["Шанхай Жанжиажэ", "Шанхай Тэнгэрийн хаалга"]

4. Аялал бүрт "child_rules" талбарыг нэм (хүүхдийн насны ангилал байвал). Жишээ:
   "child_rules": [
     { "label": "Хүүхэд", "age_range": "2-12 нас", "price": 2790000, "note": "" },
     { "label": "Нярай", "age_range": "0-2 нас", "price": 490000, "note": "" }
   ]

5. "important_notes" талбарт чухал мэдээллийг нэм (виз, паспорт, нэмэлт зардал гэх мэт).

6. ЧУХАЛ: id, route_name, operator_name болон бусад одоо байгаа талбаруудыг ӨӨРЧЛӨХГҮЙ орхино уу. Зөвхөн дээрх шинэ талбаруудыг нэм.

7. Хариултаа зөвхөн цэвэр JSON хэлбэрээр өгнө үү. Тайлбар, markdown, \`\`\`json тэмдэглэгээ хэрэглэхгүй.

Аяллын мэдээлэл:`;

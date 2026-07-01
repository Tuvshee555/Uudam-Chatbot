"use client";

import { useRef, useState } from "react";

function Ed({ value = "", onChange, as = "span", className, placeholder }) {
  const Tag = as;
  return (
    <Tag
      className={className}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder || ""}
      onBlur={(e) => {
        const txt = e.currentTarget.innerText.trim();
        if (txt !== value) onChange(txt);
      }}
    >
      {value}
    </Tag>
  );
}

function RemoveBtn({ onClick, title = "Устгах" }) {
  return (
    <button type="button" className="editor-only removebtn" onClick={onClick} title={title}>
      ×
    </button>
  );
}

const MEAL_LABELS = [
  ["breakfast", "Өглөөний цай"],
  ["lunch", "Өдрийн хоол"],
  ["dinner", "Оройн хоол"],
];
const HERO_KICKER = "😊 АЯЛАЛ БҮХЭН ДАВТАГДАШГҮЙ😊";

function cleanText(value) {
  const text = String(value ?? "").trim();
  if (!text || /^null$/i.test(text) || /^undefined$/i.test(text)) return "";
  return text;
}

function buildNarrative(day) {
  return String(day.summary || "").trim();
}

function splitSummary(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  // If the user already structured the text with line breaks, respect those groupings.
  if (t.includes("\n")) return t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  // Otherwise break the wall-of-text into one bullet per sentence.
  return t.split(/(?<=[.])\s+/).map((s) => s.trim()).filter(Boolean);
}

function BulletEd({ value, onChange, className, placeholder }) {
  const listRef = useRef(null);
  const bullets = splitSummary(value);

  const emit = () => {
    if (!listRef.current) return;
    const items = Array.from(listRef.current.querySelectorAll("li"));
    const joined = items
      .map((li) => li.innerText.replace(/\n+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
    if (joined !== value) onChange(joined);
  };

  return (
    <ul
      ref={listRef}
      className={className}
      contentEditable
      suppressContentEditableWarning
      onBlur={emit}
    >
      {bullets.length ? (
        bullets.map((s, i) => <li key={i}>{s}</li>)
      ) : (
        <li data-placeholder={placeholder || ""} />
      )}
    </ul>
  );
}

function tableFromPriceNote(note) {
  const text = String(note || "").replace(/^⚠\s*/, "").trim();
  if (!text) return null;

  const matches = [...text.matchAll(/(\d[\d\s,'’]*\d)\s*₮/g)];
  if (matches.length < 2) return null;

  let cursor = 0;
  const columns = [];
  const cells = [];
  let consumedEnd = 0;

  for (const match of matches) {
    const rawLabel = text
      .slice(cursor, match.index)
      .replace(/[—–:;,]+$/g, "")
      .trim();
    const isExplanation = /өрөөнд|ганцаараа|тусгай|нэмж|орох бол/i.test(rawLabel);
    if (isExplanation && columns.length === 0) return null;
    if (isExplanation && columns.length >= 2) break;

    const label = rawLabel || `Үнэ ${columns.length + 1}`;
    const amount = `${match[1].replace(/[’']/g, ",").replace(/\s+/g, "")}₮`;

    let end = match.index + match[0].length;
    const paren = text.slice(end).match(/^\s*(\([^)]*\))/);
    columns.push(paren ? `${label} ${paren[1]}` : label);
    cells.push(amount);

    if (paren) end += paren[0].length;
    cursor = end;
    consumedEnd = end;
  }

  if (columns.length < 2) return null;

  return {
    columns,
    rows: [{ dates: "Үнэ", cells }],
    note: text.slice(consumedEnd).replace(/^[\s—–:;,]+/, "").trim(),
    priceText: text.slice(0, consumedEnd).trim(),
    fromPriceNote: true,
  };
}

function splitPriceNotes(text) {
  const cleaned = String(text || "")
    .replace(/^⚠\s*/, "")
    .split(/\n+/)
    .map((line) => line.replace(/^[•\-]\s*/, "").trim())
    .filter(Boolean);

  if (cleaned.length <= 1) return cleaned;

  const boxes = [];
  let current = null;

  for (const line of cleaned) {
    const isHeading = /хямдрал|урамшуулал|санал|бэлэг|хөтөлбөр/i.test(line) && /[:：]$/.test(line);
    if (isHeading || !current) {
      current = { title: isHeading ? line.replace(/[:：]$/, "") : "", items: isHeading ? [] : [line] };
      boxes.push(current);
    } else {
      current.items.push(line);
    }
  }

  return boxes.map((box) => (box.title ? `${box.title}:\n${box.items.join("\n")}` : box.items.join("\n")));
}

function getPriceNoteBoxes(trip, priceTable) {
  if (priceTable?.fromPriceNote) return splitPriceNotes(priceTable.note);
  return splitPriceNotes(trip.price_note);
}

function removePriceNoteBox(trip, priceTable, boxText, upd) {
  if (priceTable?.fromPriceNote) {
    const remaining = splitPriceNotes(priceTable.note).filter((note) => note !== boxText).join("\n");
    const next = [priceTable.priceText, remaining].filter(Boolean).join(" ");
    upd(["price_note"], next);
    return;
  }

  const remaining = splitPriceNotes(trip.price_note).filter((note) => note !== boxText).join("\n");
  upd(["price_note"], remaining);
}

function updatePriceNoteBox(trip, priceTable, oldText, newText, upd) {
  const cleanNewText = String(newText || "").trim();

  if (priceTable?.fromPriceNote) {
    const notes = splitPriceNotes(priceTable.note).map((note) => (note === oldText ? cleanNewText : note)).filter(Boolean);
    const next = [priceTable.priceText, notes.join("\n")].filter(Boolean).join(" ");
    upd(["price_note"], next);
    return;
  }

  const notes = splitPriceNotes(trip.price_note).map((note) => (note === oldText ? cleanNewText : note)).filter(Boolean);
  upd(["price_note"], notes.join("\n"));
}

function getPriceTable(trip) {
  if (trip.price_table) return trip.price_table;
  const noteTable = tableFromPriceNote(trip.price_note);
  if (noteTable) return noteTable;
  if (!Array.isArray(trip.prices) || trip.prices.length === 0) return null;

  return {
    columns: ["Том хүн", "Хүүхэд"],
    rows: trip.prices.map((p) => ({
      dates: p.applies_to || "",
      cells: [
        p.adult ? `${p.adult}${p.currency || ""}` : "",
        p.child ? `${p.child}${p.currency || ""}${p.child_years ? ` (${p.child_years})` : ""}` : "",
      ],
    })),
    note: trip.child_free_note || "",
  };
}

export default function Poster({
  trip: t,
  upd,
  addItem,
  removeItem,
  insertDay,
  reorderDay,
  addPriceRow,
  addPriceCol,
  removePriceCol,
  logoSrc,
  page1Ref,
  onDayPhotoFile,
  dayPhotoInputRefs,
}) {
  const priceTable = getPriceTable(t);
  const priceNoteBoxes = getPriceNoteBoxes(t, priceTable);
  const dragIdx = useRef(null);
  const [dragOver, setDragOver] = useState(null);

  // Defined before the JSX (not inline in the ref callback) so the day-photo
  // input ref map is registered without mutating a value already read by JSX.
  function setDayPhotoInputRef(i, node) {
    if (!dayPhotoInputRefs.current) return;
    if (node) dayPhotoInputRefs.current[i] = node;
    else delete dayPhotoInputRefs.current[i];
  }

  const Logo = () => (
    <>
      <img className="logo" src={logoSrc} alt="UUDAM" />
      <div className="name">
        UUDAM<small>TRAVEL AGENCY</small>
      </div>
    </>
  );

  return (
    <>
      <div className="page" id="p1" ref={page1Ref}>
        <div className="head">
          <Logo />
          <div className="spacer" />
          <div className="head-phone">
            <span className="head-phone-ic">📞</span>
            <span className="head-phone-num">{(t.contacts?.phones || []).join(", ")}</span>
          </div>
          <div className="dur">
            <div className="dur-item"><span className="dur-emoji">☀️</span>{t.duration_days} өдөр</div>
            <div className="dur-item"><span className="dur-emoji">🌙</span>{t.duration_nights} шөнө</div>
          </div>
        </div>

        <div className="hero">
          <div className="kicker">{HERO_KICKER}</div>
          <Ed as="div" className="htitle" value={t.title} onChange={(v) => upd(["title"], v)} />
        </div>

        {priceTable || t.price_note ? (
          <div className="sec compact-sec">
            <h3>Үнэ</h3>
            {priceTable ? (
            <>
            <table className="ptable">
              <tbody>
                <tr>
                  <th>Огноо</th>
                  {priceTable.columns.map((c, ci) => (
                    <th key={ci} className="ptable-col-head">
                      {t.price_table ? <Ed value={c} placeholder="Багана нэр" onChange={(v) => upd(["price_table", "columns", ci], v)} /> : c}
                      {t.price_table && priceTable.columns.length > 1 ? (
                        <button type="button" className="editor-only col-remove-btn" onClick={() => removePriceCol(ci)} title="Багана устгах">×</button>
                      ) : null}
                    </th>
                  ))}
                  {t.price_table ? (
                    <th className="editor-only ptable-add-col-th ptable-add-col-header">
                      <button type="button" className="ptable-add-btn" onClick={addPriceCol} title="Багана нэмэх">+</button>
                    </th>
                  ) : null}
                </tr>
                {priceTable.rows.map((r, ri) => {
                  const colCount = priceTable.columns.length;
                  const cells = Array.from({ length: colCount }, (_, ci) => r.cells[ci] ?? "");
                  return (
                  <tr key={ri}>
                    <td className="pwhen">
                      {t.price_table ? (
                        <>
                          <textarea
                            className="pwhen-input"
                            key={r.dates}
                            defaultValue={r.dates}
                            placeholder="Огноо"
                            rows={1}
                            ref={(el) => {
                              if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
                            }}
                            onInput={(e) => {
                              e.target.style.height = "auto";
                              e.target.style.height = e.target.scrollHeight + "px";
                            }}
                            onBlur={(e) => upd(["price_table", "rows", ri, "dates"], e.target.value.trim())}
                          />
                          <RemoveBtn onClick={() => removeItem(["price_table", "rows"], ri)} />
                        </>
                      ) : r.dates}
                    </td>
                    {cells.map((c, ci) => (
                      <td className="pamt" key={ci}>
                        {t.price_table ? <Ed value={c} placeholder="Үнэ" onChange={(v) => upd(["price_table", "rows", ri, "cells", ci], v)} /> : c}
                      </td>
                    ))}
                    {t.price_table ? <td className="editor-only ptable-add-col-th" /> : null}
                  </tr>
                  );
                })}
              </tbody>
            </table>
            {t.price_table ? (
              <button type="button" className="editor-only ptable-add-row-btn" onClick={addPriceRow}>+ Мөр нэмэх</button>
            ) : null}
            </>
            ) : null}
            {priceNoteBoxes.length ? (
              <div className="price-note-boxes">
                {priceNoteBoxes.map((note, ni) => {
                  const lines = note.split(/\n+/).map((line) => line.trim()).filter(Boolean);
                  const title = lines.length > 1 && /[:：]$/.test(lines[0]) ? lines[0].replace(/[:：]$/, "") : "";
                  const items = title ? lines.slice(1) : lines;

                  return (
                    <div className="price-note-box" key={`${note}-${ni}`}>
                      <button
                        type="button"
                        className="editor-only price-note-remove"
                        onClick={() => removePriceNoteBox(t, priceTable, note, upd)}
                        title="Тайлбар устгах"
                      >
                        ×
                      </button>
                      <div
                        className="price-note-content"
                        contentEditable
                        suppressContentEditableWarning
                        onBlur={(e) => updatePriceNoteBox(t, priceTable, note, e.currentTarget.innerText, upd)}
                      >
                        {title ? <div className="price-note-title">{title}:</div> : null}
                        {items.length > 1 ? (
                          <ul>
                            {items.map((item, ii) => <li key={ii}>{item}</li>)}
                          </ul>
                        ) : (
                          <div className="price-note-line">⚠ {items[0]}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {/* Description box — always in editor, hidden on export if empty via CSS */}
            <Ed
              as="div"
              className="price-desc-input"
              value={t.price_desc || ""}
              placeholder="Тайлбар нэмэх..."
              onChange={(v) => upd(["price_desc"], v)}
            />
          </div>
        ) : null}

        <div className="program-head">
          <div>
            <div className="section-kicker">ХӨТӨЛБӨР</div>
            <div className="ititle">{t.title}</div>
          </div>
        </div>

        <div className="days">
          {(t.days || []).map((d, i) => {
            const narrative = buildNarrative(d);

            return (
              <div
                className={"dayrow" + (d.photo ? " has-photo" : "") + (dragOver === i ? " drag-over" : "")}
                key={i}
                draggable
                onDragStart={() => { dragIdx.current = i; }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(i); }}
                onDragLeave={() => setDragOver(null)}
                onDrop={() => {
                  setDragOver(null);
                  if (dragIdx.current !== null && dragIdx.current !== i) reorderDay(dragIdx.current, i);
                  dragIdx.current = null;
                }}
                onDragEnd={() => { setDragOver(null); dragIdx.current = null; }}
              >
                <div className="dnum" title="Чирж байрлал солих">
                  <span className="dnum-num">{d.day}</span>
                  <span className="dnum-handle editor-only">⠿</span>
                </div>

                <div className="daycard">
                  {/* Left col: title + text + meals | Right col: photo full height */}
                  <div className="dmain">
                    <div className="droute">
                      <Ed value={d.route} onChange={(v) => upd(["days", i, "route"], v)} />
                      <RemoveBtn onClick={() => removeItem(["days"], i)} title="Өдөр устгах" />
                      {d.distance_km ? <span className="km">{d.distance_km} км</span> : null}
                      {cleanText(d.flight) ? <span className="flt">✈ {cleanText(d.flight)}</span> : null}
                    </div>

                    <BulletEd
                      className="dsummary prose"
                      value={narrative}
                      placeholder="Энэ өдрийн аяллын тайлбар энд харагдана."
                      onChange={(v) => upd(["days", i, "summary"], v)}
                    />

                    {cleanText(d.hotel) ? (
                      <div className="dhotel">
                        🛏 <Ed value={cleanText(d.hotel)} onChange={(v) => upd(["days", i, "hotel"], v)} />
                      </div>
                    ) : null}

                    {d.show_meals !== false ? (
                      <div className="mealgrid">
                        {MEAL_LABELS.map(([k, label]) => {
                          const on = d.meals?.[k];
                          return (
                            <button
                              key={k}
                              type="button"
                              className={"mealcard " + (on ? "yes" : "no")}
                              onClick={() => upd(["days", i, "meals", k], !on)}
                            >
                              <span className="mealname">{label}</span>
                              <span className="mealstate">{on ? "Багтсан" : "Багтаагүй"}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  <div className="dside">
                      {d.photo ? (
                        <button
                          type="button"
                          className="dphoto clickable filled"
                          style={{
                            backgroundImage: `linear-gradient(180deg, rgba(12, 27, 43, 0.08), rgba(12, 27, 43, 0.38)), url(${d.photo})`,
                          }}
                          onClick={() => dayPhotoInputRefs.current?.[i]?.click()}
                        >
                          <span className="editor-only photohint">Дарж зураг солино</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="dphoto editor-only dphoto-empty"
                          onClick={() => dayPhotoInputRefs.current?.[i]?.click()}
                        >
                          <span className="dphoto-add-label">+ Зураг нэмэх</span>
                        </button>
                      )}

                      <input
                        ref={(node) => setDayPhotoInputRef(i, node)}
                        type="file"
                        accept="image/*"
                        className="hidden-input"
                        onChange={(e) => onDayPhotoFile(i, e.target.files?.[0])}
                      />

                      <div className="editor-only daytools">
                        {d.photo && (
                          <button type="button" className="addbtn danger" onClick={() => upd(["days", i, "photo"], null)}>
                            Фото авах
                          </button>
                        )}
                        <button type="button" className="addbtn" onClick={() => insertDay(i)}>
                          + Дараа өдөр
                        </button>
                        <button
                          type="button"
                          className="addbtn"
                          onClick={() => upd(["days", i, "show_meals"], d.show_meals === false)}
                        >
                          {d.show_meals === false ? "🍽 Хоол харуулах" : "🍽 Хоол нуух"}
                        </button>
                      </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="endpad" />

        <div className="foot">
          <span>📍 <b>{t.contacts?.address}</b></span>
          <span>✉ <b>{t.contacts?.email}</b></span>
        </div>
      </div>
    </>
  );
}

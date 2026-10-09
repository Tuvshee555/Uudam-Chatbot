function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, dec) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    );
}

function stripXmlTags(value: string): string {
  return decodeXmlEntities(
    value
      .replace(/<w:tab\b[^>]*\/?>/g, "\t")
      .replace(/<w:br\b[^>]*\/?>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function paragraphText(xml: string): string {
  return stripXmlTags(xml);
}

function tableText(xml: string): string {
  const rows = Array.from(xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g))
    .map((rowMatch) => {
      const cells = Array.from(rowMatch[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g))
        .map((cellMatch) =>
          Array.from(cellMatch[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g))
            .map((paragraphMatch) => paragraphText(paragraphMatch[0]))
            .filter(Boolean)
            .join(" / "),
        )
        .filter(Boolean);
      return cells.join(" | ");
    })
    .filter(Boolean);

  return rows.length ? `DOCX TABLE:\n${rows.join("\n")}` : "";
}

/**
 * Converts Word's document.xml into prompt-friendly text while preserving the
 * boundaries models need for accurate travel facts: paragraphs, table rows,
 * table cells, tabs, and text-box paragraphs. The document itself remains an
 * untrusted source of data, not instructions.
 */
export function docxDocumentXmlToText(xml: string): string {
  const blocks: string[] = [];
  const blockPattern = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;

  for (const match of xml.matchAll(blockPattern)) {
    const block = match[0].startsWith("<w:tbl")
      ? tableText(match[0])
      : paragraphText(match[0]);
    if (block) blocks.push(block);
  }

  const text = blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text) return text;

  return stripXmlTags(xml).replace(/\n{3,}/g, "\n\n").trim();
}

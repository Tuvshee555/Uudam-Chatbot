Fonts bundled for server-side PDF rendering (poster PDFs and the corporate catalogue).

All files are Noto fonts from the Noto Project (https://github.com/notofonts), licensed under the
SIL Open Font License 1.1 - see OFL.txt in this folder. Embedding them in generated PDFs is permitted
by that license. They are never served to web pages; the renderers read them from disk and embed
subsets in the PDF.

  NotoSans-Regular.ttf     body text (poster + catalogue)
  NotoSans-Medium.ttf      labels, titles in lists (catalogue)
  NotoSans-Bold.ttf        poster
  NotoSerif-SemiBold.ttf   catalogue headlines, prices, trip codes
  NotoSerif-Italic.ttf     catalogue captions and the "no price" wording

Glyph coverage was checked for the Cyrillic letters used in Mongolian (including Ө ө Ү ү) and the
tugrik sign. tests/catalogue-render.test.ts re-checks it from the font files themselves.

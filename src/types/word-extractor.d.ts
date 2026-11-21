/* word-extractor ships no typings: the part fileParse.ts uses to read Word 97–2003 .doc files. */
declare module "word-extractor" {
  interface ExtractedDocument {
    getBody(): string;
    getTextboxes(options?: { includeHeadersAndFooters?: boolean; includeBody?: boolean }): string;
  }
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<ExtractedDocument>;
  }
}

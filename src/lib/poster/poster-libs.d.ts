/* Loose typings for the ported poster JS libs (framework-agnostic, kept as JS). */
/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "@/lib/poster/parse" {
  export function fileToText(buffer: Buffer, filename?: string): Promise<string>;
  export function fileToImages(buffer: Buffer, filename?: string): Promise<string[]>;
}

declare module "@/lib/poster/openai" {
  export const DEFAULT_CONTACTS: any;
  export const AGENCY: string;
  export const TRIP_SCHEMA: any;
  export function normalizeExtractedTrip(trip: any): any;
  export function extractTrip(docText: string): Promise<any>;
  export function extractTripFromImage(base64: string, mimeType: string): Promise<any>;
  export function extractTripFromPdf(base64: string, filename?: string): Promise<any>;
  export function verifyDaySummaries(trip: any, pdfBase64: string, pdfFilename: string): Promise<any>;
}

declare module "@/lib/poster/pdfImages" {
  export function extractPdfImages(buffer: Buffer): Promise<string[]>;
}

declare module "@/lib/poster/pdfMeals" {
  export function extractPdfFacts(buffer: Buffer): Promise<{ meals: any; days: any }>;
  export function extractPdfMeals(buffer: Buffer): Promise<any>;
  export function applyMealMarks(trip: any, mealMap: any): any;
  export function applyDayText(trip: any, dayMap: any): any;
}

declare module "@/lib/poster/defaultTrip" {
  export function createDefaultTrip(): any;
}

declare module "pdf-parse/lib/pdf-parse.js" {
  export default function pdfParse(buffer: Buffer): Promise<{ text?: string }>;
}

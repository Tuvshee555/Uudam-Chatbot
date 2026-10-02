/**
 * Where a customer can see every trip, its full programme and prices without
 * waiting on anyone. Dependency-free on purpose: importing it must not pull
 * in Redis or the environment checks (bookingCollect.ts re-exports it).
 */
export const BOOKING_WEBSITE_URL = "https://uudam-booking-web.vercel.app";

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { queryNeon } from "../../../lib/neonDb";
import { getFaqStats, type FaqPeriodStats } from "../../../lib/travelMessages";

type LeadsByDay = { date: string; count: number };
type LeadsByTrip = { trip: string; count: number };
type LeadsByStatus = Record<string, number>;
type TopTrip = { name: string; price: number; seats_left: number };

type AnalyticsStats = {
  totalLeads: number;
  newLeads: number;
  bookingLeads: number;
  leadsByDay: LeadsByDay[];
  leadsByTrip: LeadsByTrip[];
  leadsByStatus: LeadsByStatus;
  totalTrips: number;
  activeTrips: number;
  totalContacts: number;
  topTrips: TopTrip[];
};

const ZERO_STATS: AnalyticsStats = {
  totalLeads: 0,
  newLeads: 0,
  bookingLeads: 0,
  leadsByDay: [],
  leadsByTrip: [],
  leadsByStatus: {},
  totalTrips: 0,
  activeTrips: 0,
  totalContacts: 0,
  topTrips: [],
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.analytics");
  if (!allowed) return;

  if (req.method !== "GET") {
    return res.status(405).end();
  }

  try {
    const [
      totalLeadsResult,
      newLeadsResult,
      bookingLeadsResult,
      leadsByDayResult,
      leadsByTripResult,
      leadsByStatusResult,
      totalTripsResult,
      activeTripsResult,
      totalContactsResult,
      topTripsResult,
    ] = await Promise.all([
      queryNeon<{ count: string }>("SELECT COUNT(*) as count FROM travel_leads"),
      queryNeon<{ count: string }>(
        "SELECT COUNT(*) as count FROM travel_leads WHERE lead_status = 'new_lead'",
      ),
      queryNeon<{ count: string }>(
        "SELECT COUNT(*) as count FROM travel_leads WHERE kind = 'booking'",
      ),
      queryNeon<{ date: string; count: string }>(
        `SELECT DATE(created_at)::text as date, COUNT(*) as count
         FROM travel_leads
         WHERE created_at >= NOW() - INTERVAL '14 days'
         GROUP BY DATE(created_at)
         ORDER BY date ASC`,
      ),
      queryNeon<{ trip: string; count: string }>(
        `SELECT COALESCE(trip_name, 'Тодорхойгүй') as trip, COUNT(*) as count
         FROM travel_leads
         GROUP BY trip_name
         ORDER BY count DESC
         LIMIT 10`,
      ),
      queryNeon<{ lead_status: string; count: string }>(
        `SELECT lead_status, COUNT(*) as count
         FROM travel_leads
         GROUP BY lead_status`,
      ),
      queryNeon<{ count: string }>("SELECT COUNT(*) as count FROM travel_trip_entries"),
      queryNeon<{ count: string }>(
        "SELECT COUNT(*) as count FROM travel_trip_entries WHERE status = 'active'",
      ),
      queryNeon<{ count: string }>(
        "SELECT COUNT(DISTINCT sender_id) as count FROM travel_leads",
      ),
      queryNeon<{ name: string; price: string | null; seats_left: string | null }>(
        `SELECT route_name as name, adult_price::text as price, seats_left::text as seats_left
         FROM travel_trip_entries
         WHERE status = 'active'
         ORDER BY adult_price DESC NULLS LAST
         LIMIT 5`,
      ),
    ]);

    const stats: AnalyticsStats = {
      totalLeads: parseInt(totalLeadsResult?.rows[0]?.count ?? "0", 10) || 0,
      newLeads: parseInt(newLeadsResult?.rows[0]?.count ?? "0", 10) || 0,
      bookingLeads: parseInt(bookingLeadsResult?.rows[0]?.count ?? "0", 10) || 0,
      leadsByDay: (leadsByDayResult?.rows ?? []).map((row) => ({
        date: row.date,
        count: parseInt(row.count, 10) || 0,
      })),
      leadsByTrip: (leadsByTripResult?.rows ?? []).map((row) => ({
        trip: row.trip,
        count: parseInt(row.count, 10) || 0,
      })),
      leadsByStatus: Object.fromEntries(
        (leadsByStatusResult?.rows ?? []).map((row) => [
          row.lead_status,
          parseInt(row.count, 10) || 0,
        ]),
      ),
      totalTrips: parseInt(totalTripsResult?.rows[0]?.count ?? "0", 10) || 0,
      activeTrips: parseInt(activeTripsResult?.rows[0]?.count ?? "0", 10) || 0,
      totalContacts: parseInt(totalContactsResult?.rows[0]?.count ?? "0", 10) || 0,
      topTrips: (topTripsResult?.rows ?? []).map((row) => ({
        name: row.name,
        price: parseFloat(row.price ?? "0") || 0,
        seats_left: parseInt(row.seats_left ?? "0", 10) || 0,
      })),
    };

    let faq: FaqPeriodStats = { week: [], month: [], allTime: [], totalMessages: 0 };
    try {
      faq = await getFaqStats(10);
    } catch {
      // FAQ stats are best-effort; never fail the whole analytics call.
    }

    return res.status(200).json({ ok: true, stats, faq });
  } catch {
    return res.status(200).json({ ok: true, stats: ZERO_STATS });
  }
}

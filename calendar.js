/**
 * Google Calendar Integration
 * Fetches real availability and creates confirmed booking events.
 */

import { google } from "googleapis";
import {
  addDays,
  addHours,
  addMinutes,
  startOfDay,
  setHours,
  isWeekend,
  isSaturday,
  format,
  parseISO,
} from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";

const TIMEZONE = "America/Edmonton";
const SLOT_MINUTES = parseInt(process.env.BOOKING_SLOT_MINUTES || "120");
const START_HOUR = parseInt(process.env.BOOKING_START_HOUR || "8");
const END_HOUR = parseInt(process.env.BOOKING_END_HOUR || "17");

// ── OAuth2 client ─────────────────────────────────────────────────────────────
function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: "v3", auth });
}

// ── Generate candidate slots ──────────────────────────────────────────────────
function generateCandidateSlots(urgency, preferredDate) {
  const slots = [];
  const now = toZonedTime(new Date(), TIMEZONE);

  let daysAhead;
  if (urgency === "emergency") daysAhead = 1; // Today + tomorrow
  else if (urgency === "urgent") daysAhead = 3;
  else daysAhead = 7;

  for (let d = 0; d <= daysAhead; d++) {
    const day = addDays(startOfDay(now), d);

    // Saturday: 9am-1pm only
    const dayStart = isSaturday(day) ? 9 : START_HOUR;
    const dayEnd = isSaturday(day) ? 13 : END_HOUR;

    // Skip Sundays
    if (day.getDay() === 0) continue;

    // If preferred date specified, skip non-matching days
    if (preferredDate) {
      const pDate = parseISO(preferredDate);
      if (format(day, "yyyy-MM-dd") !== format(pDate, "yyyy-MM-dd")) continue;
    }

    let slotStart = setHours(day, dayStart);

    // For today, start from next available slot (add 2hr buffer)
    if (d === 0) {
      const earliest = addHours(now, 2);
      if (earliest > slotStart) {
        // Round up to next slot boundary
        const minsFromStart =
          (earliest - slotStart) / (1000 * 60) + SLOT_MINUTES;
        const slotsFromStart = Math.ceil(minsFromStart / SLOT_MINUTES);
        slotStart = addMinutes(slotStart, slotsFromStart * SLOT_MINUTES);
      }
    }

    while (addMinutes(slotStart, SLOT_MINUTES) <= setHours(day, dayEnd)) {
      const slotEnd = addMinutes(slotStart, SLOT_MINUTES);
      slots.push({
        id: `slot_${slotStart.getTime()}`,
        start: slotStart,
        end: slotEnd,
      });
      slotStart = slotEnd;
    }
  }

  return slots;
}

// ── Check availability against Google Calendar ────────────────────────────────
async function getExistingEvents(start, end) {
  // In development/demo mode, return empty (no existing events)
  if (!process.env.GOOGLE_REFRESH_TOKEN || process.env.NODE_ENV === "demo") {
    return [];
  }

  try {
    const calendar = getCalendarClient();
    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });
    return response.data.items || [];
  } catch (err) {
    console.warn("[Calendar] Could not fetch events:", err.message);
    return [];
  }
}

// ── Public: get available slots ───────────────────────────────────────────────
export async function getAvailableSlots(urgency, preferredDate) {
  const candidates = generateCandidateSlots(urgency, preferredDate);
  if (!candidates.length) return [];

  const rangeStart = candidates[0].start;
  const rangeEnd = candidates[candidates.length - 1].end;
  const existingEvents = await getExistingEvents(rangeStart, rangeEnd);

  // Filter out slots that overlap with existing events
  const available = candidates.filter((slot) => {
    return !existingEvents.some((event) => {
      if (!event.start?.dateTime) return false;
      const evStart = new Date(event.start.dateTime);
      const evEnd = new Date(event.end.dateTime);
      return slot.start < evEnd && slot.end > evStart;
    });
  });

  // Return top 5 slots with human-readable display
  return available.slice(0, 5).map((slot) => ({
    id: slot.id,
    display: formatSlot(slot.start, slot.end),
    start_iso: slot.start.toISOString(),
    end_iso: slot.end.toISOString(),
    is_today:
      format(slot.start, "yyyy-MM-dd") ===
      format(toZonedTime(new Date(), TIMEZONE), "yyyy-MM-dd"),
    is_tomorrow:
      format(slot.start, "yyyy-MM-dd") ===
      format(
        addDays(toZonedTime(new Date(), TIMEZONE), 1),
        "yyyy-MM-dd"
      ),
  }));
}

// ── Public: book a slot ───────────────────────────────────────────────────────
export async function bookSlot(details) {
  const { slot_id, customer_name, customer_phone, customer_address,
    service_type, issue_description, is_emergency, leadPhone } = details;

  // Parse slot time from ID
  const slotTimestamp = parseInt(slot_id.replace("slot_", ""));
  const slotStart = new Date(slotTimestamp);
  const slotEnd = addMinutes(slotStart, SLOT_MINUTES);

  const bookingId = `BK${Date.now().toString(36).toUpperCase()}`;
  const slotDisplay = formatSlot(slotStart, slotEnd);

  const eventDescription = `
Service: ${service_type}
Issue: ${issue_description || "Not specified"}
Customer Phone: ${customer_phone}
Address: ${customer_address || "To be confirmed"}
Emergency: ${is_emergency ? "YES - surcharge applies" : "No"}
Booking ID: ${bookingId}
Booked via: AI Lead Bot
  `.trim();

  let eventLink = null;

  // Create calendar event if Google Calendar is configured
  if (process.env.GOOGLE_REFRESH_TOKEN && process.env.NODE_ENV !== "demo") {
    try {
      const calendar = getCalendarClient();
      const event = await calendar.events.insert({
        calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
        resource: {
          summary: `${is_emergency ? "⚡ EMERGENCY: " : ""}${service_type} — ${customer_name}`,
          description: eventDescription,
          start: {
            dateTime: slotStart.toISOString(),
            timeZone: TIMEZONE,
          },
          end: {
            dateTime: slotEnd.toISOString(),
            timeZone: TIMEZONE,
          },
          reminders: {
            useDefault: false,
            overrides: [
              { method: "email", minutes: 60 },
              { method: "popup", minutes: 30 },
            ],
          },
        },
      });
      eventLink = event.data.htmlLink;
    } catch (err) {
      console.warn("[Calendar] Could not create event:", err.message);
    }
  }

  return {
    id: bookingId,
    customerName: customer_name,
    customerPhone: customer_phone,
    customerAddress: customer_address,
    serviceType: service_type,
    issueDescription: issue_description,
    isEmergency: is_emergency,
    slotDisplay,
    slotStart: slotStart.toISOString(),
    slotEnd: slotEnd.toISOString(),
    eventLink,
    confirmationText: `Your appointment is confirmed for ${slotDisplay}. Booking #${bookingId}. A technician will arrive in the service window — you'll get a call 30 mins before. Questions? Call ${process.env.BUSINESS_PHONE}.`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatSlot(start, end) {
  const day = formatInTimeZone(start, TIMEZONE, "EEEE, MMMM d");
  const startTime = formatInTimeZone(start, TIMEZONE, "h:mm a");
  const endTime = formatInTimeZone(end, TIMEZONE, "h:mm a");
  return `${day}, ${startTime}–${endTime} MT`;
}

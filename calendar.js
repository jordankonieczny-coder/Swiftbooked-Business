import { google } from "googleapis";

const TIMEZONE = "America/Edmonton";
const BASE_URL = process.env.BASE_URL || "https://swiftbooked-business-production.up.railway.app";

function makeAuth(refreshToken) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/auth/google/callback`
  );
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

// Create a confirmed booking event on the client's Google Calendar
export async function createBookingEvent(refreshToken, { summary, description, location, date, startTime, endTime }) {
  const auth = makeAuth(refreshToken);
  const cal = google.calendar({ version: "v3", auth });

  const event = await cal.events.insert({
    calendarId: "primary",
    resource: {
      summary,
      description,
      ...(location ? { location } : {}),
      start: { dateTime: `${date}T${startTime}:00`, timeZone: TIMEZONE },
      end:   { dateTime: `${date}T${endTime}:00`,   timeZone: TIMEZONE },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 60 },
          { method: "popup", minutes: 30 },
        ],
      },
    },
  });
  return event.data;
}

// Generate the Google OAuth URL for a specific client (used by /connect-calendar/:id)
export function makeConnectUrl(clientId) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/auth/google/callback`
  );
  const state = `cal:${clientId}:${Math.random().toString(36).slice(2)}`;
  const url = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    state,
  });
  return { url, state };
}

// Check free/busy for a client's calendar over a date range
export async function getFreeBusy(refreshToken, timeMin, timeMax) {
  const auth = makeAuth(refreshToken);
  const cal = google.calendar({ version: "v3", auth });
  const res = await cal.freebusy.query({
    resource: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: "primary" }],
    },
  });
  return res.data.calendars?.primary?.busy || [];
}

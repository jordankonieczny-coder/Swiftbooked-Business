/**
 * Swiftbooked — Main Server
 *
 * Endpoints:
 *   POST /api/chat          — Website demo chatbot (Claude-powered)
 *   POST /webhook/sms       — Twilio inbound SMS
 *   POST /webhook/form      — Web form lead submissions
 *   POST /webhook/lsa       — Google Local Services Ads leads
 *   GET  /health            — Status check
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import twilio from "twilio";
import { Resend } from "resend";
import { google } from "googleapis";
import Stripe from "stripe";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { handleChat, handleIncomingMessage, getSession } from "./ai-engine.js";
import { initDB, getClientByNumber, getAllClients, createClient, updateClient, deleteClient, saveCalendarToken, getClientByEmail, setClientPassword, upsertLead, getAllLeads, getLeadsByClient } from "./db.js";
import { makeConnectUrl } from "./calendar.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);

// ── Serve static website ─────────────────────────────────────────────────────
app.use(express.static(join(__dirname, "website")));

// ── CORS — allow website demo to call this API ───────────────────────────────
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
  })
);

// ── Stripe ────────────────────────────────────────────────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Stripe webhook — raw body MUST be parsed before express.json()
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(500).send("Stripe not configured");

  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
      console.warn("[Stripe] No STRIPE_WEBHOOK_SECRET — skipping signature verification");
    }
  } catch (err) {
    console.error("[Stripe webhook] Invalid signature:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const m = session.metadata || {};
    console.log(`[Stripe] New signup: ${m.business} (${m.email})`);
    try {
      await sendNewSignupEmails({
        name: m.name,
        business: m.business,
        email: m.email,
        phone: m.phone,
        trade: m.trade,
        plan: m.plan,
        stripeCustomerId: session.customer,
      });
    } catch (err) {
      console.error("[Stripe webhook] Email error:", err.message);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const demoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,                   // 50 requests per IP per 15 min
  message: { error: "Too many requests — please try again in a few minutes." },
});

const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Rate limit exceeded" },
});

// ── Twilio client ─────────────────────────────────────────────────────────────
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/chat — Website demo chatbot
// Body: { sessionId, message, config: { bizName, trade, callout, job1, job2, hours, area } }
// ═════════════════════════════════════════════════════════════════════════════
app.post("/api/chat", demoLimiter, async (req, res) => {
  const { sessionId, message, config } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: "sessionId and message are required" });
  }

  if (message.length > 500) {
    return res.status(400).json({ error: "Message too long" });
  }

  try {
    const result = await handleChat(sessionId, message, config || {});
    res.json(result);
  } catch (err) {
    console.error("[/api/chat error]", err.message);
    res.status(500).json({
      error: "AI unavailable",
      reply:
        "Sorry, I'm having a technical issue. Please call 587-568-7784 directly.",
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /webhook/sms — Twilio inbound SMS
// ═════════════════════════════════════════════════════════════════════════════
app.post("/webhook/sms", smsLimiter, async (req, res) => {
  const { From: phone, Body: messageText, To: toNumber } = req.body;

  if (!phone || !messageText) {
    return res.type("text/xml").send("<Response/>");
  }

  console.log(`[SMS in] ${phone} → ${toNumber}: "${messageText}"`);

  try {
    // Look up which client owns this Twilio number
    const client = toNumber ? await getClientByNumber(toNumber) : null;
    const config = client ? {
      bizName:             client.business_name,
      trade:               client.trade,
      hours:               client.hours,
      area:                client.service_area,
      callout:             client.callout_fee,
      job1:                client.job1,
      job2:                client.job2,
      faq:                 client.faq,
      googleRefreshToken:  client.google_refresh_token || null,
    } : null;

    const result = await handleIncomingMessage(phone, messageText, null, config);
    await sendSMSFrom(phone, result.reply, toNumber);

    // Persist lead to DB
    if (client) {
      const session = getSession(`sms_${phone}`);
      const messages = session?.messages || [];
      const status = result.booked ? "booked" : (result.escalated ? "escalated" : "active");
      upsertLead(client.id, phone, messages, status, result.bookingId || null).catch(err =>
        console.error("[Lead save error]", err.message)
      );
    }

    res.type("text/xml").send("<Response/>");
  } catch (err) {
    console.error("[SMS webhook error]", err.message);
    await sendSMSFrom(
      phone,
      `Sorry, we're having a technical issue. Please call ${process.env.OWNER_PHONE || "587-568-7784"} directly.`,
      toNumber
    );
    res.type("text/xml").send("<Response/>");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /webhook/form — Website contact form / Zapier / Facebook Lead Ads
// ═════════════════════════════════════════════════════════════════════════════
app.post("/webhook/form", async (req, res) => {
  const { name, phone, email, message, service } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "Phone number required" });
  }

  const cleanPhone = normalizePhone(phone);
  const initialMsg = [
    service ? `I need help with: ${service}` : null,
    message || null,
    name ? `My name is ${name}` : null,
  ]
    .filter(Boolean)
    .join(". ");

  console.log(`[Form lead] ${name || "Unknown"} ${cleanPhone}: "${initialMsg}"`);

  try {
    const result = await handleIncomingMessage(
      cleanPhone,
      initialMsg || "I'd like to book a service",
      name
    );
    await sendSMS(cleanPhone, result.reply);
    res.json({ success: true, message: "Lead response sent via SMS" });
  } catch (err) {
    console.error("[Form webhook error]", err.message);
    res.status(500).json({ error: "Failed to process lead" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /webhook/lsa — Google Local Services Ads
// ═════════════════════════════════════════════════════════════════════════════
app.post("/webhook/lsa", async (req, res) => {
  const { consumer_name, consumer_phone_number, job_type, note } = req.body;

  if (!consumer_phone_number) {
    return res.status(400).json({ error: "Phone required" });
  }

  const phone = normalizePhone(consumer_phone_number);
  const message = [
    job_type ? `I need ${job_type} service` : "I saw your Google listing",
    note || null,
  ]
    .filter(Boolean)
    .join(". ");

  try {
    const result = await handleIncomingMessage(phone, message, consumer_name);
    await sendSMS(phone, result.reply);
    res.json({ success: true });
  } catch (err) {
    console.error("[LSA webhook error]", err.message);
    res.status(500).json({ error: "Failed to process LSA lead" });
  }
});

// ── Email transporter ─────────────────────────────────────────────────────────
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.log(`[Email - not configured] To: ${to} | Subject: ${subject}`);
    return;
  }
  const { error } = await resend.emails.send({
    from: "Swiftbooked <onboarding@resend.dev>",
    to,
    subject,
    html,
  });
  if (error) throw new Error(error.message);
}

if (resend) console.log("[Email] Resend configured");

// ── Google OAuth ──────────────────────────────────────────────────────────────
const BASE_URL = process.env.BASE_URL || "https://swiftbooked-business-production.up.railway.app";

const googleOAuth = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  ? new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      `${BASE_URL}/auth/google/callback`
    )
  : null;

// Temporary in-memory store: state token → client signup info (expires after 1 hour)
const oauthSessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, v] of oauthSessions) if (v.createdAt < cutoff) oauthSessions.delete(k);
}, 10 * 60 * 1000);

function generateState(data) {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  oauthSessions.set(state, { ...data, createdAt: Date.now() });
  return state;
}

// GET /auth/google?state=<token> — redirect client to Google consent screen
app.get("/auth/google", (req, res) => {
  if (!googleOAuth) return res.status(503).send("Google OAuth not configured.");
  const { state } = req.query;
  if (!state || !oauthSessions.has(state)) {
    return res.status(400).send("Invalid or expired link. Please sign up again.");
  }
  const url = googleOAuth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"],
    state,
  });
  res.redirect(url);
});

// GET /auth/google/callback — Google redirects here after approval
app.get("/auth/google/callback", async (req, res) => {
  if (!googleOAuth) return res.status(503).send("Google OAuth not configured.");
  const { code, state, error } = req.query;

  if (error) return res.send(`<h2>Access denied.</h2><p>You can close this tab and try again, or contact Jordan at <a href="tel:5875687784">587-568-7784</a>.</p>`);

  const session = oauthSessions.get(state);
  if (!session) return res.status(400).send("Session expired. Please sign up again.");

  try {
    const { tokens } = await googleOAuth.getToken(code);
    oauthSessions.delete(state);

    let clientName = session?.business || "Unknown";

    // If state is a direct client-connect flow (cal:clientId:token), save token to DB
    if (state && state.startsWith("cal:")) {
      const clientId = state.split(":")[1];
      if (clientId && tokens.refresh_token) {
        try {
          const updated = await saveCalendarToken(parseInt(clientId), tokens.refresh_token);
          if (updated) clientName = updated.business_name;
          console.log(`[Calendar] Token saved for client ${clientId} (${clientName})`);
        } catch (err) {
          console.error("[Calendar] Failed to save token:", err.message);
        }
      }
    } else if (session?.email && tokens.refresh_token) {
      // Legacy signup flow: try to find client by email and save token
      try {
        const client = await getClientByEmail(session.email);
        if (client) {
          await saveCalendarToken(client.id, tokens.refresh_token);
          console.log(`[Calendar] Token saved for ${client.business_name} via email lookup`);
        }
      } catch (err) {
        console.error("[Calendar] Email lookup failed:", err.message);
      }
    }

    // Notify Jordan
    if (resend && tokens.refresh_token) {
      await sendEmail({
        to: process.env.OWNER_EMAIL,
        subject: `✅ Google Calendar connected: ${clientName}`,
        html: `
<div style="font-family:Arial,sans-serif;max-width:500px;">
  <h2 style="color:#16a34a;">Google Calendar Connected ✅</h2>
  <p><strong>${clientName}</strong> just authorized Google Calendar access. Token saved to database.</p>
  ${session ? `<table style="border-collapse:collapse;width:100%;font-size:0.9rem;">
    <tr><td style="padding:6px 0;font-weight:700;width:140px;">Business</td><td>${session.business || clientName}</td></tr>
    <tr><td style="padding:6px 0;font-weight:700;">Email</td><td>${session.email || "—"}</td></tr>
  </table>` : ""}
  <p style="color:#16a34a;font-weight:700;">Calendar bookings will now land directly in their Google Calendar.</p>
</div>`,
      });
    }

    res.send(`
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;}
.box{max-width:420px;text-align:center;padding:40px 32px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
h2{color:#16a34a;margin-bottom:8px;}p{color:#4b5563;line-height:1.6;}</style></head>
<body><div class="box">
<div style="font-size:3rem;">✅</div>
<h2>Calendar connected!</h2>
<p>Your Google Calendar is now linked to Swiftbooked. Jordan will have your AI bot live within 48 hours.</p>
<p style="font-size:0.9rem;">Questions? Call or text <a href="tel:5875687784" style="color:#1a56db;">587-568-7784</a>.</p>
</div></body></html>`);
  } catch (err) {
    console.error("[OAuth callback error]", err.message);
    res.status(500).send("Something went wrong. Please contact Jordan at 587-568-7784.");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/signup
// ═════════════════════════════════════════════════════════════════════════════
app.post("/api/signup", async (req, res) => {
  const { name, business, email, phone, trade, trade_other } = req.body;
  if (!name || !email) return res.status(400).json({ error: "Missing required fields" });

  const tradeName = trade === "other" ? trade_other : trade;

  // Generate Google Calendar OAuth link if configured
  const oauthState = googleOAuth
    ? generateState({ name, business, email, phone, trade: tradeName })
    : null;
  const calendarConnectUrl = oauthState ? `${BASE_URL}/auth/google?state=${oauthState}` : null;

  const calendarSection = calendarConnectUrl
    ? `<div style="background:#f0fdf4;border:2px solid #16a34a;border-radius:10px;padding:20px 24px;margin:20px 0;text-align:center;">
        <p style="font-weight:700;font-size:1rem;margin:0 0 8px;color:#166534;">📅 Connect Your Calendar</p>
        <p style="color:#166534;font-size:0.9rem;margin:0 0 16px;">Click below to securely link your Google Calendar. We never see your password — Google handles the login.</p>
        <a href="${calendarConnectUrl}" style="display:inline-block;background:#1a56db;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">Connect Google Calendar →</a>
        <p style="color:#6b7280;font-size:0.8rem;margin:12px 0 0;">Using Outlook, Apple Calendar, or Calendly? Let us know in your questionnaire reply and we'll walk you through it.</p>
      </div>`
    : `<p><strong>5. Calendar app &amp; access</strong><br><span style="color:#6b7280;font-size:0.9rem;">Which calendar do you use? (Google Calendar, Apple Calendar, Outlook, Calendly, or other). We'll send you a secure connect link.</span></p>`;

  // Email to customer — setup questionnaire via Google Form
  const customerHtml = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
  <div style="background:#1a56db;padding:28px 32px;border-radius:10px 10px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:1.4rem;">Welcome to Swiftbooked, ${name.split(' ')[0]}!</h1>
    <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:0.95rem;">Your AI text bot is almost ready. One quick form and you're done.</p>
  </div>
  <div style="background:#f9fafb;padding:28px 32px;border-radius:0 0 10px 10px;border:1px solid #e5e7eb;border-top:none;">
    <p style="margin-top:0;">Hi ${name},</p>
    <p>We're setting up your Swiftbooked AI text bot for <strong>${business}</strong>. To get it live within 48 hours, fill out the short setup form below — it takes about 3 minutes.</p>

    <div style="text-align:center;margin:28px 0;">
      <a href="https://docs.google.com/forms/d/e/1FAIpQLScKpzHwAr-r3_Mwg8fsh-lRGeXnaJlZ8GQYE0Qbs1czr5Y3cQ/viewform"
         style="display:inline-block;background:#1a56db;color:#fff;padding:16px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:1.05rem;">
        Fill Out Setup Form →
      </a>
      <p style="color:#6b7280;font-size:0.85rem;margin:12px 0 0;">Takes about 3 minutes · No account required</p>
    </div>

    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:18px 24px;margin:20px 0;">
      <p style="margin:0 0 10px;font-weight:700;font-size:0.95rem;color:#374151;">The form covers:</p>
      <ul style="margin:0;padding-left:20px;color:#6b7280;font-size:0.9rem;line-height:1.9;">
        <li>Your services &amp; pricing</li>
        <li>Service area &amp; business hours</li>
        <li>Emergency contact number</li>
        <li>Calendar connection</li>
        <li>Common customer Q&amp;A</li>
        <li>Anything else the AI should know</li>
      </ul>
    </div>

    ${calendarSection}

    <p>Once you submit the form, we'll configure your bot and have it live within <strong>48 hours</strong>. You'll get a test text to confirm everything is working before we go live.</p>
    <p>Questions? Reply to this email or call/text Jordan directly at <a href="tel:5875687784" style="color:#1a56db;">587-568-7784</a>.</p>
    <p style="margin-bottom:0;">— Jordan Konieczny<br><span style="color:#6b7280;font-size:0.9rem;">Swiftbooked</span></p>
  </div>
</div>`;

  // Notification email to Jordan
  const ownerHtml = `
<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
  <h2 style="color:#1a56db;">New Swiftbooked Signup 🎉</h2>
  <table style="border-collapse:collapse;width:100%;">
    <tr><td style="padding:8px 0;font-weight:700;width:130px;">Name</td><td>${name}</td></tr>
    <tr><td style="padding:8px 0;font-weight:700;">Business</td><td>${business}</td></tr>
    <tr><td style="padding:8px 0;font-weight:700;">Email</td><td><a href="mailto:${email}">${email}</a></td></tr>
    <tr><td style="padding:8px 0;font-weight:700;">Phone</td><td><a href="tel:${phone}">${phone}</a></td></tr>
    <tr><td style="padding:8px 0;font-weight:700;">Trade</td><td>${tradeName}</td></tr>
  </table>
  <p style="color:#6b7280;font-size:0.9rem;">Questionnaire sent to customer. Reply when they respond to set them up.</p>
</div>`;

  try {
    if (resend) {
      await Promise.all([
        sendEmail({
          to: email,
          subject: `Welcome to Swiftbooked — let's get your AI bot live`,
          html: customerHtml,
        }),
        sendEmail({
          to: process.env.OWNER_EMAIL,
          subject: `New signup: ${business} (${tradeName})`,
          html: ownerHtml,
        }),
      ]);
    } else {
      console.log(`[Signup - email not configured] ${name} | ${business} | ${email} | ${phone} | ${tradeName}`);
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[/api/signup error]", err.message);
    res.status(500).json({ error: "Failed to send emails" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/create-checkout-session — Stripe hosted checkout
// ═════════════════════════════════════════════════════════════════════════════
app.post("/api/create-checkout-session", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

  const { name, business, email, phone, trade, trade_other, plan } = req.body;
  if (!name || !email || !business) {
    return res.status(400).json({ error: "Name, email, and business name are required" });
  }

  const tradeName = trade === "other" ? (trade_other || "other") : (trade || "other");
  const isPro = plan === "pro-299";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{
        price_data: {
          currency: "cad",
          product_data: {
            name: isPro ? "Swiftbooked Pro" : "Swiftbooked Essential",
            description: isPro
              ? "AI SMS bot + website chat widget — unlimited leads, 24/7 coverage"
              : "AI SMS text bot — unlimited leads, 24/7 coverage",
          },
          unit_amount: isPro ? 29900 : 19900,
          recurring: { interval: "month" },
        },
        quantity: 1,
      }],
      subscription_data: { trial_period_days: 30 },
      metadata: { name, business, email, phone: phone || "", trade: tradeName, plan: isPro ? "pro" : "essential" },
      success_url: `${BASE_URL}/?signup=success`,
      cancel_url: `${BASE_URL}/#signup`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[create-checkout-session error]", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ── Shared signup email helper (called by webhook + legacy /api/signup) ───────
async function sendNewSignupEmails({ name, business, email, phone, trade, plan, stripeCustomerId }) {
  const firstName = name.split(" ")[0];
  const planLabel = plan === "pro" ? "Pro — $299/mo" : "Essential — $199/mo";

  const customerHtml = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
  <div style="background:#1a56db;padding:28px 32px;border-radius:10px 10px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:1.4rem;">Welcome to Swiftbooked, ${firstName}!</h1>
    <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:0.95rem;">Your AI text bot is almost ready. One quick form and you're done.</p>
  </div>
  <div style="background:#f9fafb;padding:28px 32px;border-radius:0 0 10px 10px;border:1px solid #e5e7eb;border-top:none;">
    <p style="margin-top:0;">Hi ${firstName},</p>
    <p>We're setting up your Swiftbooked AI text bot for <strong>${business}</strong>. To get it live within 48 hours, fill out the short setup form below — it takes about 3 minutes.</p>
    <div style="text-align:center;margin:28px 0;">
      <a href="https://docs.google.com/forms/d/e/1FAIpQLScKpzHwAr-r3_Mwg8fsh-lRGeXnaJlZ8GQYE0Qbs1czr5Y3cQ/viewform"
         style="display:inline-block;background:#1a56db;color:#fff;padding:16px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:1.05rem;">
        Fill Out Setup Form →
      </a>
      <p style="color:#6b7280;font-size:0.85rem;margin:12px 0 0;">Takes about 3 minutes · No account required</p>
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:18px 24px;margin:20px 0;">
      <p style="margin:0 0 10px;font-weight:700;font-size:0.95rem;color:#374151;">The form covers:</p>
      <ul style="margin:0;padding-left:20px;color:#6b7280;font-size:0.9rem;line-height:1.9;">
        <li>Your services &amp; pricing</li>
        <li>Service area &amp; business hours</li>
        <li>Emergency contact number</li>
        <li>Calendar connection</li>
        <li>Common customer Q&amp;A</li>
        <li>Anything else the AI should know</li>
      </ul>
    </div>
    <p>Your first month is <strong>free</strong> — no charge for 30 days. After that your ${planLabel} subscription begins automatically.</p>
    <p>Once you submit the form, we'll configure your bot and have it live within <strong>48 hours</strong>. You'll get a test text to confirm everything is working before we go live.</p>
    <p>Questions? Reply to this email or call/text Jordan directly at <a href="tel:5875687784" style="color:#1a56db;">587-568-7784</a>.</p>
    <p style="margin-bottom:0;">— Jordan Konieczny<br><span style="color:#6b7280;font-size:0.9rem;">Swiftbooked</span></p>
  </div>
</div>`;

  const ownerHtml = `
<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
  <h2 style="color:#1a56db;">New Swiftbooked Signup 🎉</h2>
  <table style="border-collapse:collapse;width:100%;">
    <tr><td style="padding:8px 0;font-weight:700;width:130px;">Name</td><td>${name}</td></tr>
    <tr><td style="padding:8px 0;font-weight:700;">Business</td><td>${business}</td></tr>
    <tr><td style="padding:8px 0;font-weight:700;">Email</td><td><a href="mailto:${email}">${email}</a></td></tr>
    <tr><td style="padding:8px 0;font-weight:700;">Phone</td><td><a href="tel:${phone}">${phone}</a></td></tr>
    <tr><td style="padding:8px 0;font-weight:700;">Trade</td><td>${trade}</td></tr>
    <tr><td style="padding:8px 0;font-weight:700;">Plan</td><td>${planLabel}</td></tr>
    ${stripeCustomerId ? `<tr><td style="padding:8px 0;font-weight:700;">Stripe</td><td><a href="https://dashboard.stripe.com/customers/${stripeCustomerId}">${stripeCustomerId}</a></td></tr>` : ""}
  </table>
  <p style="color:#6b7280;font-size:0.9rem;">Card on file — trial ends in 30 days then auto-charges. Setup form sent to customer.</p>
</div>`;

  if (resend) {
    await Promise.all([
      sendEmail({ to: email, subject: `Welcome to Swiftbooked — let's get your AI bot live`, html: customerHtml }),
      sendEmail({ to: process.env.OWNER_EMAIL, subject: `New signup: ${business} (${trade}) — ${planLabel}`, html: ownerHtml }),
    ]);
  } else {
    console.log(`[Signup emails not sent - Resend not configured] ${name} | ${business} | ${email}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /connect-calendar/:id — sends client through Google OAuth for a specific client record
// ═════════════════════════════════════════════════════════════════════════════
app.get("/connect-calendar/:id", (req, res) => {
  if (!googleOAuth) return res.status(503).send("Google OAuth not configured.");
  const { id } = req.params;
  if (!id || isNaN(parseInt(id))) return res.status(400).send("Invalid client ID.");
  const { url } = makeConnectUrl(id);
  res.redirect(url);
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN — password protected client management
// ═════════════════════════════════════════════════════════════════════════════

const JWT_SECRET = process.env.JWT_SECRET || "swiftbooked-portal-secret-change-in-prod";
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme === "Basic" && encoded) {
    const [, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (pass === (process.env.ADMIN_PASSWORD || "swiftbooked")) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Swiftbooked Admin"');
  res.status(401).send("Unauthorized");
}

app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(join(__dirname, "website", "admin.html"));
});

app.get("/api/admin/clients", requireAdmin, async (req, res) => {
  const clients = await getAllClients();
  res.json(clients);
});

app.post("/api/admin/clients", requireAdmin, async (req, res) => {
  try {
    const client = await createClient(req.body);
    res.json(client);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/admin/clients/:id", requireAdmin, async (req, res) => {
  try {
    const client = await updateClient(req.params.id, req.body);
    res.json(client);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/clients/:id", requireAdmin, async (req, res) => {
  await deleteClient(req.params.id);
  res.json({ success: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /health
// ═════════════════════════════════════════════════════════════════════════════
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Swiftbooked AI Bot",
    owner: process.env.OWNER_NAME,
    twilioConnected: !!twilioClient,
    anthropicConfigured: !!process.env.ANTHROPIC_API_KEY,
    timestamp: new Date().toISOString(),
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function sendSMSFrom(to, message, fromNumber) {
  const from = fromNumber || process.env.TWILIO_PHONE_NUMBER;
  if (!twilioClient) {
    console.log(`[SMS - not sent, no Twilio] ${from} → ${to}: "${message}"`);
    return;
  }
  const chunks = splitSMS(message);
  for (const chunk of chunks) {
    await twilioClient.messages.create({ body: chunk, from, to });
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 500));
  }
}

// Keep old name as alias so existing callers still work
async function sendSMS(to, message) {
  return sendSMSFrom(to, message, null);
}

function splitSMS(text, max = 155) {
  if (text.length <= max) return [text];
  const chunks = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > max) {
      if (current) chunks.push(current.trim());
      current = s;
    } else {
      current += (current ? " " : "") + s;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

function normalizePhone(raw) {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

if (process.env.DATABASE_URL) {
  initDB().catch(err => console.error("[DB init error]", err.message));
} else {
  console.log("[DB] No DATABASE_URL — running without database");
}

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  Swiftbooked AI Bot — Live on port ${PORT}
║  Owner: ${process.env.OWNER_NAME || "Not set"}
║  Twilio: ${twilioClient ? "Connected" : "Not connected (SMS disabled)"}
║  Claude: ${process.env.ANTHROPIC_API_KEY ? "Connected" : "API key missing!"}
║
║  POST /api/chat       ← Website demo
║  POST /webhook/sms    ← Twilio
║  POST /webhook/form   ← Web forms / Zapier / Facebook
║  POST /webhook/lsa    ← Google Local Services
║  GET  /health         ← Status
╚══════════════════════════════════════════════════════╝
  `);
});

export default app;

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
import { initDB, getClientByNumber, getAllClients, createClient, updateClient, deleteClient, saveCalendarToken, getClientByEmail, setClientPassword, upsertLead, getAllLeads, getLeadsByClient, getClientByWidgetKey, setWidgetKey, setStripeCustomerId, createPartialClient, setSetupToken, getClientBySetupToken, completeSetup } from "./db.js";
import { randomBytes } from "crypto";
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

  if (!webhookSecret) {
    console.error("[Stripe] STRIPE_WEBHOOK_SECRET not set — rejecting webhook");
    return res.status(400).send("Webhook Error: webhook secret not configured");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("[Stripe webhook] Invalid signature:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const m = session.metadata || {};
    console.log(`[Stripe] New signup: ${m.business} (${m.email})`);
    try {
      // Create partial client record immediately
      const client = await createPartialClient({
        business_name: m.business,
        trade: m.trade,
        owner_name: m.name,
        owner_email: m.email?.toLowerCase().trim(),
        owner_phone: m.phone || null,
        plan: m.plan,
        stripe_customer_id: session.customer,
      });

      // Generate setup token (expires in 7 days)
      const token = randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await setSetupToken(client.id, token, expires);

      // Send setup email to client + notify Jordan
      await sendSetupEmail({ client, token, plan: m.plan });
    } catch (err) {
      console.error("[Stripe webhook] Setup error:", err.message);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const demoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: "Too many requests — please try again in a few minutes." },
});

const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Rate limit exceeded" },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts — please try again in 15 minutes." },
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

    // Persist lead to DB + fire owner alerts
    if (client) {
      const session = getSession(`sms_${phone}`);
      const messages = session?.messages || [];
      const status = result.booked ? "booked" : (result.escalated ? "escalated" : "active");
      upsertLead(client.id, phone, messages, status, result.bookingId || null).catch(err =>
        console.error("[Lead save error]", err.message)
      );

      if (result.escalated || result.booked) {
        const lastCustomerMsg = [...messages].reverse().find(m => m.role === "user")?.content || "";
        sendClientAlerts({ client, customerPhone: phone, fromNumber: toNumber, result, lastCustomerMsg })
          .catch(err => console.error("[Alert error]", err.message));
      }
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

// ── Client alert: escalation or booking notification ─────────────────────────
async function sendClientAlerts({ client, customerPhone, fromNumber, result, lastCustomerMsg }) {
  const isEscalation = result.escalated;
  const bizName = client.business_name;
  const portalUrl = `${BASE_URL}/portal`;

  // SMS to client owner (from their own Twilio number)
  if (client.owner_phone && twilioClient) {
    const smsBody = isEscalation
      ? `🔴 ${bizName} — Customer needs you\nPhone: ${customerPhone}\nThey said: "${lastCustomerMsg.slice(0, 100)}"\nCall or text them directly.`
      : `✅ ${bizName} — New booking!\nCustomer: ${customerPhone}\nConfirmation: #${result.bookingId}\nView details: ${portalUrl}`;
    await sendSMSFrom(client.owner_phone, smsBody, fromNumber).catch(err =>
      console.error("[Alert SMS error]", err.message)
    );
  }

  // Email to client owner
  if (client.owner_email) {
    const subject = isEscalation
      ? `🔴 Customer needs a callback — ${bizName}`
      : `✅ New booking confirmed — ${bizName}`;

    const html = isEscalation
      ? `<div style="font-family:Arial,sans-serif;max-width:500px;">
          <h2 style="color:#dc2626;">Customer Needs a Callback</h2>
          <p>A customer texting your <strong>${bizName}</strong> AI bot has requested to speak with someone directly.</p>
          <table style="border-collapse:collapse;width:100%;font-size:0.9rem;">
            <tr><td style="padding:6px 0;font-weight:700;width:160px;">Customer Phone</td><td><a href="tel:${customerPhone}">${customerPhone}</a></td></tr>
            <tr><td style="padding:6px 0;font-weight:700;">Last Message</td><td><em>"${lastCustomerMsg.slice(0, 200)}"</em></td></tr>
          </table>
          <p style="margin-top:16px;">Call or text them back as soon as you can.</p>
          <p><a href="${portalUrl}" style="color:#1a56db;">View full conversation →</a></p>
        </div>`
      : `<div style="font-family:Arial,sans-serif;max-width:500px;">
          <h2 style="color:#16a34a;">New Booking Confirmed ✅</h2>
          <p>Your <strong>${bizName}</strong> AI bot just booked a new appointment.</p>
          <table style="border-collapse:collapse;width:100%;font-size:0.9rem;">
            <tr><td style="padding:6px 0;font-weight:700;width:160px;">Customer Phone</td><td><a href="tel:${customerPhone}">${customerPhone}</a></td></tr>
            <tr><td style="padding:6px 0;font-weight:700;">Confirmation #</td><td>${result.bookingId}</td></tr>
          </table>
          <p style="margin-top:16px;"><a href="${portalUrl}" style="color:#1a56db;">View full conversation in your portal →</a></p>
        </div>`;

    await sendEmail({ to: client.owner_email, subject, html }).catch(err =>
      console.error("[Alert email error]", err.message)
    );
  }

  // Notify Jordan on escalations
  if (isEscalation && process.env.OWNER_EMAIL) {
    await sendEmail({
      to: process.env.OWNER_EMAIL,
      subject: `⚠️ Escalation: ${bizName} — ${customerPhone}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;">
        <h2 style="color:#dc2626;">Escalation Alert</h2>
        <p><strong>${bizName}</strong> — customer <a href="tel:${customerPhone}">${customerPhone}</a> requested a human.</p>
        <p><em>"${lastCustomerMsg.slice(0, 300)}"</em></p>
        <p><a href="${BASE_URL}/admin/leads">View in admin →</a></p>
      </div>`,
    }).catch(err => console.error("[Jordan alert error]", err.message));
  }
}

// ── Setup email sent to new clients after Stripe payment ─────────────────────
async function sendSetupEmail({ client, token, plan }) {
  const setupUrl = `${BASE_URL}/setup?token=${token}`;
  const firstName = (client.owner_name || "there").split(" ")[0];
  const planLabel = plan === "pro" ? "Pro — $299/mo" : "Essential — $199/mo";

  await Promise.all([
    sendEmail({
      to: client.owner_email,
      subject: `Welcome to Swiftbooked — set up your AI bot (takes 3 min)`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
        <div style="background:#1a56db;padding:28px 32px;border-radius:10px 10px 0 0;">
          <h1 style="color:#fff;margin:0;font-size:1.4rem;">Welcome to Swiftbooked, ${firstName}!</h1>
          <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;">Your payment went through. Now let's get your AI bot configured.</p>
        </div>
        <div style="background:#f9fafb;padding:28px 32px;border-radius:0 0 10px 10px;border:1px solid #e5e7eb;border-top:none;">
          <p style="margin-top:0;">Hi ${firstName},</p>
          <p>To get your bot live, we just need a few details about <strong>${client.business_name}</strong> — your hours, services, and pricing. Takes about 3 minutes.</p>
          <div style="text-align:center;margin:28px 0;">
            <a href="${setupUrl}" style="display:inline-block;background:#1a56db;color:#fff;padding:16px 36px;border-radius:10px;text-decoration:none;font-weight:700;font-size:1.05rem;">Set Up My Bot →</a>
            <p style="color:#6b7280;font-size:0.85rem;margin:12px 0 0;">Takes 3 minutes · This link expires in 7 days</p>
          </div>
          <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:18px 24px;margin:20px 0;">
            <p style="margin:0 0 10px;font-weight:700;font-size:0.95rem;color:#374151;">The form covers:</p>
            <ul style="margin:0;padding-left:20px;color:#6b7280;font-size:0.9rem;line-height:1.9;">
              <li>Trade type &amp; business hours</li>
              <li>Service area</li>
              <li>Your services &amp; pricing</li>
              <li>Common customer questions</li>
              <li>Your client portal password</li>
            </ul>
          </div>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:20px 0;">
            <p style="margin:0 0 6px;font-weight:700;color:#166534;">Your Client Portal</p>
            <p style="margin:0;font-size:0.9rem;color:#166534;">After setup, track your leads and manage billing at: <a href="${BASE_URL}/portal" style="color:#15803d;font-weight:700;">${BASE_URL}/portal</a></p>
          </div>
          <p>Your first month is <strong>free</strong> — no charge for 30 days (${planLabel} after that).</p>
          <p>Questions? Call or text Jordan at <a href="tel:5875687784" style="color:#1a56db;">587-568-7784</a>.</p>
          <p style="margin-bottom:0;">— Jordan Konieczny<br><span style="color:#6b7280;font-size:0.9rem;">Swiftbooked</span></p>
        </div>
      </div>`,
    }),
    sendEmail({
      to: process.env.OWNER_EMAIL,
      subject: `New signup: ${client.business_name} (${plan}) — setup link sent`,
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;">
        <h2 style="color:#1a56db;">New Swiftbooked Signup 🎉</h2>
        <table style="border-collapse:collapse;width:100%;">
          <tr><td style="padding:8px 0;font-weight:700;width:130px;">Name</td><td>${client.owner_name}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Business</td><td>${client.business_name}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Email</td><td><a href="mailto:${client.owner_email}">${client.owner_email}</a></td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Plan</td><td>${planLabel}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700;">Status</td><td>⏳ Awaiting client setup</td></tr>
        </table>
        <p style="color:#6b7280;font-size:0.9rem;">Setup link sent to client. You'll get another email when they complete the form — then just assign a Twilio number and activate.</p>
      </div>`,
    }),
  ]).catch(err => console.error("[sendSetupEmail error]", err.message));
}

// Demo checkout — admin only, skips Stripe, sends real emails, creates client record
app.post("/api/demo-checkout", requireAdmin, async (req, res) => {
  const { name, business, email, phone, trade, trade_other, plan } = req.body;
  if (!name || !email || !business) return res.status(400).json({ error: "Name, email, and business required" });

  const tradeName = trade === "other" ? (trade_other || "other") : (trade || "other");
  const planKey = plan === "pro-299" ? "pro" : "essential";

  try {
    const client = await createPartialClient({
      business_name: business, trade: tradeName,
      owner_name: name, owner_email: email.toLowerCase().trim(),
      owner_phone: phone || null, plan: planKey,
    });
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await setSetupToken(client.id, token, expires);
    await sendSetupEmail({ client, token, plan: planKey });
    console.log(`[Demo signup] ${name} | ${business} | ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[Demo checkout error]", err.message);
    res.status(500).json({ error: err.message });
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
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:20px 0;">
      <p style="margin:0 0 6px;font-weight:700;color:#166534;">Your Client Portal</p>
      <p style="margin:0;font-size:0.9rem;color:#166534;">Track your leads, bookings, and manage billing anytime at: <a href="${BASE_URL}/portal" style="color:#15803d;font-weight:700;">${BASE_URL}/portal</a></p>
    </div>
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
// SETUP WIZARD — client self-onboarding
// ═════════════════════════════════════════════════════════════════════════════

app.get("/setup", (req, res) => {
  res.sendFile(join(__dirname, "website", "setup.html"));
});

app.get("/api/setup/validate/:token", async (req, res) => {
  const client = await getClientBySetupToken(req.params.token).catch(() => null);
  if (!client) return res.status(404).json({ error: "This setup link is invalid or has expired. Contact Jordan at 587-568-7784." });
  if (client.setup_completed) return res.status(410).json({ error: "Setup is already complete. Log in at swiftbooked.ca/portal" });
  res.json({
    business_name: client.business_name,
    owner_name: client.owner_name,
    trade: client.trade,
    owner_phone: client.owner_phone || "",
    calendar_url: `${BASE_URL}/connect-calendar/${client.id}`,
    has_calendar: !!client.google_refresh_token,
  });
});

app.post("/api/setup/:token", async (req, res) => {
  const client = await getClientBySetupToken(req.params.token).catch(() => null);
  if (!client) return res.status(404).json({ error: "Invalid or expired setup link." });
  if (client.setup_completed) return res.status(410).json({ error: "Already completed." });

  const { trade, hours, service_area, callout_fee, job1, job2, faq, owner_phone, password } = req.body;
  if (!trade || !hours || !service_area) return res.status(400).json({ error: "Trade, hours, and service area are required." });
  if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await completeSetup(client.id, { trade, hours, service_area, callout_fee, job1, job2, faq, owner_phone }, passwordHash);

    // Notify Jordan
    await sendEmail({
      to: process.env.OWNER_EMAIL,
      subject: `✅ Setup complete — ${client.business_name} is ready to activate`,
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;">
        <h2 style="color:#1a56db;">Client Setup Complete 🎉</h2>
        <p><strong>${client.business_name}</strong> just finished their onboarding form. All they need is a Twilio number to go live.</p>
        <table style="border-collapse:collapse;width:100%;font-size:0.9rem;">
          <tr><td style="padding:6px 0;font-weight:700;width:140px;">Owner</td><td>${client.owner_name}</td></tr>
          <tr><td style="padding:6px 0;font-weight:700;">Email</td><td>${client.owner_email}</td></tr>
          <tr><td style="padding:6px 0;font-weight:700;">Phone</td><td>${owner_phone || client.owner_phone || "—"}</td></tr>
          <tr><td style="padding:6px 0;font-weight:700;">Trade</td><td>${trade}</td></tr>
          <tr><td style="padding:6px 0;font-weight:700;">Hours</td><td>${hours}</td></tr>
          <tr><td style="padding:6px 0;font-weight:700;">Service Area</td><td>${service_area}</td></tr>
          <tr><td style="padding:6px 0;font-weight:700;">Plan</td><td>${client.plan}</td></tr>
        </table>
        <p style="margin-top:16px;"><strong>Next step:</strong> Assign a Twilio number in the admin panel and set them to Active.</p>
        <a href="${BASE_URL}/admin" style="display:inline-block;background:#1a56db;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px;">Open Admin Panel →</a>
      </div>`,
    }).catch(err => console.error("[Setup notify error]", err.message));

    res.json({ success: true });
  } catch (err) {
    console.error("[Setup complete error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// WIDGET — embeddable chat for Pro clients
// ═════════════════════════════════════════════════════════════════════════════

// Return business name so widget can greet with the right name
app.get("/api/widget/config", async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: "key required" });
  const client = await getClientByWidgetKey(key).catch(() => null);
  if (!client) return res.status(404).json({ error: "Widget not found" });
  res.json({ business_name: client.business_name });
});

// Handle chat messages from embedded widget
app.post("/api/widget/chat", demoLimiter, async (req, res) => {
  const { key, sessionId, message } = req.body;
  if (!key || !sessionId || !message) return res.status(400).json({ error: "key, sessionId, and message required" });
  if (message.length > 500) return res.status(400).json({ error: "Message too long" });

  const client = await getClientByWidgetKey(key).catch(() => null);
  if (!client) return res.status(404).json({ error: "Widget not found" });

  const config = {
    bizName:  client.business_name,
    trade:    client.trade,
    hours:    client.hours,
    area:     client.service_area,
    callout:  client.callout_fee,
    job1:     client.job1,
    job2:     client.job2,
    faq:      client.faq,
  };

  try {
    const result = await handleChat(`widget_${key}_${sessionId}`, message, config);
    res.json({ reply: result.reply });
  } catch (err) {
    console.error("[Widget chat error]", err.message);
    res.status(500).json({ reply: "Sorry, I'm having trouble right now. Please call us directly." });
  }
});

// Generate (or regenerate) a widget key for a client
app.post("/api/admin/clients/:id/widget-key", requireAdmin, async (req, res) => {
  const key = "sb_" + Math.random().toString(36).slice(2, 10);
  try {
    const client = await setWidgetKey(parseInt(req.params.id), key);
    res.json({ widget_key: client.widget_key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN — password protected client management
// ═════════════════════════════════════════════════════════════════════════════

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET environment variable is not set");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD environment variable is not set");

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme === "Basic" && encoded) {
    const [, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (pass === ADMIN_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Swiftbooked Admin"');
  res.status(401).send("Unauthorized");
}

app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(join(__dirname, "website", "admin.html"));
});

// Demo mode — full site with Stripe bypassed (admin only)
app.get("/demo", requireAdmin, async (req, res) => {
  try {
    const { readFile } = await import("fs/promises");
    let html = await readFile(join(__dirname, "website", "index.html"), "utf-8");
    html = html.replace("</body>", `<script>
window.__SB_DEMO__ = true;
(function(){
  var bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#f59e0b;color:#111;text-align:center;padding:8px;font-family:monospace;font-size:0.85rem;font-weight:700;';
  bar.textContent = '\\u26a0 DEMO MODE \\u2014 Stripe bypassed. Real emails will be sent.';
  document.body.prepend(bar);
})();
</script>\n</body>`);
    res.type("html").send(html);
  } catch (err) {
    res.status(500).send("Could not load demo page.");
  }
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
// ADMIN — Lead log
// ═════════════════════════════════════════════════════════════════════════════
app.get("/admin/leads", requireAdmin, (req, res) => {
  res.sendFile(join(__dirname, "website", "admin-leads.html"));
});

app.get("/api/admin/leads", requireAdmin, async (req, res) => {
  try {
    const leads = await getAllLeads();
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set password for a client (admin only)
app.post("/api/admin/clients/:id/password", requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const hash = await bcrypt.hash(password, 10);
    await setClientPassword(parseInt(req.params.id), hash);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CLIENT PORTAL — /portal
// ═════════════════════════════════════════════════════════════════════════════
app.get("/portal", (req, res) => {
  res.sendFile(join(__dirname, "website", "portal.html"));
});

app.post("/api/portal/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  try {
    const client = await getClientByEmail(email.toLowerCase().trim());
    if (!client || !client.password_hash) return res.status(401).json({ error: "Invalid email or password" });

    const valid = await bcrypt.compare(password, client.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });

    const token = jwt.sign({ clientId: client.id, email: client.owner_email }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, client: { id: client.id, business_name: client.business_name, owner_name: client.owner_name, plan: client.plan } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function requirePortalAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.portalUser = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired — please log in again" });
  }
}

app.get("/api/portal/leads", requirePortalAuth, async (req, res) => {
  try {
    const leads = await getLeadsByClient(req.portalUser.clientId);
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/portal/me", requirePortalAuth, async (req, res) => {
  try {
    const clients = await getAllClients();
    const client = clients.find(c => c.id === req.portalUser.clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });
    const { password_hash, google_refresh_token, ...safe } = client;
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/portal/billing", requirePortalAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Billing not configured" });

  try {
    const clients = await getAllClients();
    const client = clients.find(c => c.id === req.portalUser.clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });

    let customerId = client.stripe_customer_id;

    // Fallback: look up by email in Stripe if we don't have the ID stored
    if (!customerId && client.owner_email) {
      const results = await stripe.customers.list({ email: client.owner_email.toLowerCase(), limit: 1 });
      if (results.data.length) {
        customerId = results.data[0].id;
        await setStripeCustomerId(client.id, customerId);
      }
    }

    if (!customerId) {
      return res.status(404).json({ error: "No billing account found. Contact Jordan at 587-568-7784." });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${BASE_URL}/portal`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error("[Billing portal error]", err.message);
    res.status(500).json({ error: err.message });
  }
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

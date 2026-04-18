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
import { handleChat, handleIncomingMessage } from "./ai-engine.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// ── Serve static website ─────────────────────────────────────────────────────
app.use(express.static(join(__dirname, "website")));

// ── CORS — allow website demo to call this API ───────────────────────────────
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
  })
);

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
  const { From: phone, Body: messageText } = req.body;

  if (!phone || !messageText) {
    return res.type("text/xml").send("<Response/>");
  }

  console.log(`[SMS in] ${phone}: "${messageText}"`);

  try {
    const result = await handleIncomingMessage(phone, messageText);
    await sendSMS(phone, result.reply);
    res.type("text/xml").send("<Response/>");
  } catch (err) {
    console.error("[SMS webhook error]", err.message);
    await sendSMS(
      phone,
      `Sorry, we're having a technical issue. Please call ${process.env.OWNER_PHONE || "587-568-7784"} directly.`
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
async function sendSMS(to, message) {
  if (!twilioClient) {
    console.log(`[SMS - not sent, no Twilio] → ${to}: "${message}"`);
    return;
  }
  const chunks = splitSMS(message);
  for (const chunk of chunks) {
    await twilioClient.messages.create({
      body: chunk,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 500));
  }
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

/**
 * Main server — handles all inbound lead sources:
 *   POST /webhook/sms       — Twilio inbound SMS
 *   POST /webhook/form      — Web form submissions
 *   POST /webhook/lsa       — Google Local Services Ads leads
 *   POST /demo              — Demo mode (no real SMS/calendar)
 */

import "dotenv/config";
import express from "express";
import twilio from "twilio";
import { handleIncomingMessage } from "./ai-engine.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// ── Twilio inbound SMS ────────────────────────────────────────────────────────
app.post("/webhook/sms", async (req, res) => {
  const { From: phone, Body: messageText } = req.body;
  console.log(`[SMS] From ${phone}: "${messageText}"`);

  try {
    const result = await handleIncomingMessage(phone, messageText);
    await sendSMS(phone, result.message);

    // Twilio expects empty TwiML response (we're sending separately)
    res.type("text/xml").send("<Response/>");
  } catch (err) {
    console.error("[SMS webhook error]", err);
    await sendSMS(
      phone,
      `Sorry, we're having a technical issue. Please call us directly at ${process.env.BUSINESS_PHONE}.`
    );
    res.type("text/xml").send("<Response/>");
  }
});

// ── Web form webhook ──────────────────────────────────────────────────────────
// Connect this to your website's contact form (Gravity Forms, WPForms, etc.)
app.post("/webhook/form", async (req, res) => {
  const { name, phone, email, message, service } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "Phone number required" });
  }

  // Normalize phone to E.164
  const cleanPhone = normalizePhone(phone);

  // Build initial message from form data
  const initialMsg = [
    service ? `I need help with: ${service}` : null,
    message || null,
    name ? `My name is ${name}` : null,
  ]
    .filter(Boolean)
    .join(". ");

  console.log(`[Form lead] ${name} ${cleanPhone}: "${initialMsg}"`);

  try {
    const result = await handleIncomingMessage(
      cleanPhone,
      initialMsg || "I'd like to book a service",
      name
    );
    await sendSMS(cleanPhone, result.message);
    res.json({ success: true, message: "Lead response sent via SMS" });
  } catch (err) {
    console.error("[Form webhook error]", err);
    res.status(500).json({ error: "Failed to process lead" });
  }
});

// ── Google LSA lead webhook ───────────────────────────────────────────────────
app.post("/webhook/lsa", async (req, res) => {
  // Google LSA sends lead data in this format
  const { consumer_name, consumer_phone_number, job_type, note } = req.body;

  const phone = normalizePhone(consumer_phone_number);
  const message = [
    job_type ? `I need ${job_type} service` : "I saw your Google listing",
    note || null,
  ]
    .filter(Boolean)
    .join(". ");

  try {
    const result = await handleIncomingMessage(phone, message, consumer_name);
    await sendSMS(phone, result.message);
    res.json({ success: true });
  } catch (err) {
    console.error("[LSA webhook error]", err);
    res.status(500).json({ error: "Failed to process LSA lead" });
  }
});

// ── Demo endpoint (no real SMS or calendar) ───────────────────────────────────
app.post("/demo", async (req, res) => {
  const { phone = "+17805550001", message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  try {
    const result = await handleIncomingMessage(phone, message);
    res.json(result);
  } catch (err) {
    console.error("[Demo error]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    business: process.env.BUSINESS_NAME,
    type: process.env.BUSINESS_TYPE,
    twilioConnected: !!twilioClient,
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function sendSMS(to, message) {
  if (!twilioClient) {
    console.log(`[SMS - NOT SENT (no Twilio)] To ${to}: "${message}"`);
    return;
  }
  // Split long messages (SMS 160 char limit)
  const chunks = splitSMS(message);
  for (const chunk of chunks) {
    await twilioClient.messages.create({
      body: chunk,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    // Small delay between multi-part messages
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 500));
  }
}

function splitSMS(text, maxLength = 155) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = "";
  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength) {
      if (current) chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? " " : "") + sentence;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║  Trades Lead Bot — ${process.env.BUSINESS_NAME || "Not configured"}
║  Type: ${process.env.BUSINESS_TYPE || "Not set"}
║  Port: ${PORT}
║
║  Endpoints:
║    POST /webhook/sms   ← Twilio webhook URL
║    POST /webhook/form  ← Website contact form
║    POST /webhook/lsa   ← Google Local Services
║    POST /demo          ← Test without real SMS
║    GET  /health        ← Status check
╚═══════════════════════════════════════════════════════╝
  `);
});

export default app;

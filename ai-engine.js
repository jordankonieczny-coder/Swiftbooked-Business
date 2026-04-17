/**
 * AI Conversation Engine
 * Handles the full lead qualification → booking conversation using Claude.
 * Each lead gets a stateful conversation thread stored in memory (use Redis in production).
 */

import Anthropic from "@anthropic-ai/sdk";
import { getAvailableSlots, bookSlot } from "./calendar.js";
import { formatInTimeZone } from "date-fns-tz";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In production, replace with Redis: conversations.set(phone, state)
const conversations = new Map();

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const businessName = process.env.BUSINESS_NAME || "your company";
  const businessType = process.env.BUSINESS_TYPE || "hvac";
  const emergencySurcharge = process.env.EMERGENCY_SURCHARGE || "150";

  const serviceDescriptions = {
    hvac: "furnace repair/replacement, AC service, boiler maintenance, duct cleaning, thermostat installation",
    plumbing:
      "leak repair, drain clearing, water heater service/replacement, fixture installation, sewer inspection",
    electrical:
      "panel upgrades, circuit installation, outlet repair, EV charger installation, lighting",
    construction:
      "renovations, additions, basement development, deck building, general contracting",
  };

  return `You are an AI booking assistant for ${businessName}, a trades company in Edmonton, Alberta.

Your job: respond to new leads within 2 minutes, qualify them, and book an appointment — all via text message.

SERVICES WE OFFER: ${serviceDescriptions[businessType] || "trades services"}

YOUR PERSONALITY:
- Friendly, professional, and local (you know Edmonton — mention neighbourhoods if they share them)
- Conversational and concise — this is SMS, keep messages under 160 characters when possible
- Never pushy. Never salesy. Just helpful and efficient.
- If they mention it's cold (furnace issue in winter), acknowledge the urgency immediately

CONVERSATION GOALS (in order):
1. Acknowledge their inquiry warmly within the first message
2. Identify what service they need (if not already stated)
3. Confirm their address / neighbourhood (helps with scheduling)
4. Ask if this is urgent (same-day/emergency) or can be scheduled
5. Offer 2-3 specific time slots from available calendar
6. Confirm the booking with their name and a summary
7. Send a confirmation with what to expect

BOOKING RULES:
- Regular hours: Mon–Fri 8am–5pm, Sat 9am–1pm (Mountain Time)
- After-hours/emergency: available but $${emergencySurcharge} surcharge — always mention this
- Always offer the earliest available slot first for urgent requests
- 2-hour service windows (e.g. "between 10am–12pm")

WHAT TO COLLECT BEFORE BOOKING:
- First name
- Address or neighbourhood (for routing)
- Brief description of the issue
- Phone number (you already have it, just confirm)

IF THEY'RE NOT READY TO BOOK:
- Offer to send a reminder tomorrow
- Never ghost them — always end with a clear next step

TOOLS AVAILABLE:
- get_available_slots: fetch real calendar availability
- book_appointment: confirm a slot and create the booking
- escalate_to_human: if the situation is complex, dangerous, or customer is upset

IMPORTANT: Never make up availability. Always call get_available_slots before offering times.
Never quote prices for actual jobs — say "our tech will assess on-site and provide a quote".
For gas leaks or flooding: immediately say to call 911 / shut off the main and we'll be there ASAP.`;
}

// ── Tool definitions (Claude function calling) ───────────────────────────────
const tools = [
  {
    name: "get_available_slots",
    description:
      "Get available appointment slots from the business calendar. Call this before offering any times to the customer.",
    input_schema: {
      type: "object",
      properties: {
        urgency: {
          type: "string",
          enum: ["emergency", "urgent", "standard"],
          description:
            "emergency = same day, urgent = next 48hrs, standard = this week",
        },
        preferred_day: {
          type: "string",
          description: "Optional: specific date requested (YYYY-MM-DD)",
        },
      },
      required: ["urgency"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book a confirmed appointment slot. Only call this once the customer has explicitly agreed to a time.",
    input_schema: {
      type: "object",
      properties: {
        customer_name: { type: "string" },
        customer_phone: { type: "string" },
        customer_address: { type: "string" },
        service_type: { type: "string" },
        issue_description: { type: "string" },
        slot_id: {
          type: "string",
          description: "The slot ID returned by get_available_slots",
        },
        is_emergency: { type: "boolean" },
      },
      required: [
        "customer_name",
        "customer_phone",
        "service_type",
        "slot_id",
        "is_emergency",
      ],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand off to a human team member. Use for: gas leaks, flooding, angry customers, complex commercial jobs, or anything you cannot resolve.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        urgency: { type: "string", enum: ["immediate", "soon", "when_free"] },
        summary: {
          type: "string",
          description: "Brief summary of the conversation so far",
        },
      },
      required: ["reason", "urgency", "summary"],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput, leadPhone) {
  console.log(`[Tool] ${toolName}`, toolInput);

  switch (toolName) {
    case "get_available_slots": {
      const slots = await getAvailableSlots(
        toolInput.urgency,
        toolInput.preferred_day
      );
      return {
        slots,
        timezone: "America/Edmonton",
        note: "All times in Mountain Time (Edmonton)",
      };
    }

    case "book_appointment": {
      const booking = await bookSlot({
        ...toolInput,
        leadPhone,
      });
      // Notify owner
      await notifyOwner(booking);
      return {
        success: true,
        booking_id: booking.id,
        confirmation: booking.confirmationText,
        calendar_event: booking.eventLink,
      };
    }

    case "escalate_to_human": {
      await notifyOwnerUrgent(toolInput, leadPhone);
      return {
        escalated: true,
        message:
          "Owner has been notified and will contact the customer directly.",
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Main conversation handler ─────────────────────────────────────────────────
export async function handleIncomingMessage(
  leadPhone,
  messageText,
  leadName = null
) {
  // Load or initialize conversation state
  let state = conversations.get(leadPhone) || {
    messages: [],
    leadData: { phone: leadPhone, name: leadName },
    startedAt: new Date().toISOString(),
    booked: false,
  };

  // Add user message
  state.messages.push({ role: "user", content: messageText });

  console.log(
    `[Conversation] ${leadPhone} (${state.messages.length} messages): "${messageText}"`
  );

  try {
    // Agentic loop — Claude may use multiple tools before responding
    let finalResponse = null;
    let iterationCount = 0;
    const MAX_ITERATIONS = 5;

    while (!finalResponse && iterationCount < MAX_ITERATIONS) {
      iterationCount++;

      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: buildSystemPrompt(),
        tools,
        messages: state.messages,
      });

      // Handle tool use
      if (response.stop_reason === "tool_use") {
        // Add assistant's tool-use message to history
        state.messages.push({ role: "assistant", content: response.content });

        // Execute all tool calls
        const toolResults = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            const result = await executeTool(block.name, block.input, leadPhone);

            // Track booking state
            if (block.name === "book_appointment" && result.success) {
              state.booked = true;
              state.bookingId = result.booking_id;
            }

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          }
        }

        // Add tool results to history
        state.messages.push({ role: "user", content: toolResults });
      } else {
        // Final text response
        finalResponse = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");

        state.messages.push({ role: "assistant", content: finalResponse });
      }
    }

    // Save updated state
    conversations.set(leadPhone, state);

    return {
      message: finalResponse,
      booked: state.booked,
      bookingId: state.bookingId || null,
      conversationLength: state.messages.length,
    };
  } catch (error) {
    console.error("[AI Engine Error]", error);
    throw error;
  }
}

// ── Owner notifications ───────────────────────────────────────────────────────
async function notifyOwner(booking) {
  const subject = `New booking: ${booking.customerName} — ${booking.serviceType}`;
  const body = `
New appointment booked via AI assistant:

Customer: ${booking.customerName}
Phone: ${booking.customerPhone}
Address: ${booking.customerAddress || "Not provided"}
Service: ${booking.serviceType}
Issue: ${booking.issueDescription || "Not specified"}
Time: ${booking.slotDisplay}
Emergency: ${booking.isEmergency ? "YES" : "No"}
Booking ID: ${booking.id}

Calendar: ${booking.eventLink}
  `.trim();

  console.log(`[Owner Notify] ${subject}\n${body}`);
  // In production: send via nodemailer / Slack webhook
}

async function notifyOwnerUrgent(escalation, leadPhone) {
  console.log(
    `[ESCALATE - ${escalation.urgency.toUpperCase()}] Phone: ${leadPhone}\nReason: ${escalation.reason}\nSummary: ${escalation.summary}`
  );
  // In production: SMS the owner directly via Twilio
}

// ── Conversation state helpers ────────────────────────────────────────────────
export function getConversationState(phone) {
  return conversations.get(phone) || null;
}

export function clearConversation(phone) {
  conversations.delete(phone);
}

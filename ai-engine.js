/**
 * SwiftBot AI Engine
 * Powered by Claude — handles lead qualification, Q&A, and booking via SMS and web demo.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createBookingEvent } from "./calendar.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory session store (use Redis in production)
const sessions = new Map();

// ── Comprehensive trades knowledge base ───────────────────────────────────────
const TRADES_KNOWLEDGE = `
TRADE KNOWLEDGE BASE (Edmonton, Alberta market — use this to answer any customer question):

=== HVAC ===
Services: Furnace repair/replacement, AC installation/repair, boiler service, heat pump install, duct cleaning, HRV/ERV units, thermostat/smart thermostat install, humidifiers, air quality systems.
Pricing: Service call $120–$180. Furnace repair $300–$900. Furnace replacement $3,500–$8,000 installed. AC unit $3,000–$6,500 installed. Duct cleaning $300–$500 for average home. Boiler service $150–$300.
Emergencies: No heat in winter = URGENT (especially below -20°C). Gas smell = STOP, evacuate, call ATCO Gas 1-800-511-3447 THEN call us. Carbon monoxide alarm = evacuate immediately.
Brands we work with: Lennox, Carrier, Trane, Goodman, Napoleon, Bryant.
Common issues: Furnace not igniting (dirty flame sensor), no heat (thermostat, pilot, blower), AC not cooling (refrigerant, capacitor), high energy bills (dirty filter, aging system).
Edmonton-specific: Furnaces here work 8–9 months/year. Average furnace life 15–20 years. -35°C winter nights make no-heat calls true emergencies. APS rebates available for high-efficiency units.

=== PLUMBING ===
Services: Leak detection/repair, drain clearing, water heater service/replacement, fixture install (toilets, faucets, sinks), sewer inspection, water softener, backflow prevention, roughed-in plumbing, sump pumps.
Pricing: Service call $100–$160. Drain clearing $150–$350. Water heater replacement $1,200–$2,500 installed. Toilet install $200–$400. Leak repair $150–$500+. Sewer scope $250–$400.
Emergencies: Burst pipe = shut off main water valve immediately. Sewer backup = do not use any drains. Flooding = turn off water and electricity if safe to do so.
Water heater life: Tank heaters 8–12 years, tankless 15–20 years.
Edmonton-specific: Pipes freeze in uninsulated crawl spaces during cold snaps. City of Edmonton has rebates for water-efficient fixtures.

=== ELECTRICAL ===
Services: Panel upgrades (100A → 200A), circuit additions, outlet installation, EV charger install (Level 2), pot lights, ceiling fans, smoke/CO detector install, hot tub wiring, garage sub-panel, troubleshooting.
Pricing: Service call $100–$160. Outlet install $150–$300. Panel upgrade $2,500–$5,000. EV charger install $800–$1,800. Pot light package (10 lights) $600–$1,200. Hot tub circuit $800–$1,500.
Safety: Any burning smell = turn off breaker immediately. Flickering lights, tripping breakers, warm outlets = fire hazard, book ASAP.
Permits: All panel work and new circuits require permits in Edmonton. We pull all permits.
Edmonton-specific: Most homes built before 1990 need panel upgrades for EV chargers. City rebates for EV charger install through EPCOR.

=== GENERAL CONTRACTING ===
Services: Basement development, kitchen/bathroom renovation, room additions, deck building, flooring install, drywall, framing, tile work, project management.
Pricing: Basement development $35,000–$75,000. Kitchen reno $20,000–$80,000+. Bathroom reno $10,000–$35,000. Deck (pressure-treated) $8,000–$25,000. Per sq ft: $100–$200 for finished basement.
Timeline: Basement development 6–12 weeks. Kitchen reno 4–8 weeks. Permits required for structural work and basement development.
Edmonton-specific: Permits required through City of Edmonton for most renovation work. Basement suite rules vary by zone.

=== LANDSCAPING ===
Services: Lawn care/maintenance, sod installation, garden design, tree/shrub planting, irrigation systems, retaining walls, interlock/paving stone, spring/fall cleanup, fertilization, aeration.
Pricing: Lawn cut $40–$80/visit. Sod install $2–$4/sq ft installed. Irrigation system $3,000–$8,000. Retaining wall $30–$50/sq ft. Spring cleanup $200–$600. Aeration $100–$200.
Season: Edmonton season April–October. Spring cleanup April–May, fall cleanup October. Irrigation winterization October before freeze.

=== ROOFING ===
Services: Shingle replacement, flat roof (TPO, EPDM), leak repair, eavestroughing, soffit/fascia, skylight install, roof inspection, insurance claim work.
Pricing: Shingle reroof (average home) $8,000–$18,000. Flat roof $5–$15/sq ft. Leak repair $300–$1,500. Eavestrough replace $1,500–$4,000. Roof inspection $150–$300.
Emergencies: Active leak = we tarp same-day. Hail damage = document with photos for insurance.
Edmonton-specific: Hail is common June–August. Most home insurance covers hail. Asphalt shingles last 20–30 years in Edmonton climate.

=== PAINTING ===
Services: Interior painting (walls, ceilings, trim, cabinets), exterior painting, staining, pressure washing, drywall repair prep, colour consultation.
Pricing: Average home interior $3,000–$7,000. Single room $400–$900. Exterior $4,000–$12,000. Cabinet painting $1,500–$4,000. Pressure wash $200–$500.
Season: Exterior painting May–September (no paint below +5°C).

=== APPLIANCE REPAIR ===
Services: Washer, dryer, fridge, dishwasher, stove/oven, microwave, freezer repair. All major brands.
Pricing: Service call $80–$130 (often applied to repair). Typical repair $150–$400. Parts extra. If repair exceeds 50% of replacement cost, we'll tell you honestly.
Brands: Samsung, LG, Whirlpool, GE, Bosch, Maytag, Frigidaire, KitchenAid.
Turnaround: Same-day or next-day in most cases.

=== GARAGE DOORS ===
Services: Spring replacement, cable repair, opener install (LiftMaster, Chamberlain), panel replacement, new door install, smart opener upgrade, annual maintenance.
Pricing: Spring replacement $180–$350. Opener install $400–$800. New door install $1,200–$4,500. Service call $80–$150.
Emergencies: Broken spring = door won't open manually safely. Same-day service available.

=== WINDOWS & DOORS ===
Services: Window replacement, entry door install, patio door, storm doors, weatherstripping, window repair, glass replacement.
Pricing: Window replacement $400–$1,200 per window installed. Entry door $1,500–$5,000 installed. Patio door $2,000–$6,000 installed.
Edmonton-specific: Triple-pane windows recommended for Edmonton climate. Energy rebates available.

=== PEST CONTROL ===
Services: Mice, rats, ants, wasps, bedbugs, cockroaches, spiders, wildlife exclusion. Residential and commercial.
Pricing: Inspection $75–$150. Mouse control $200–$500 (2–3 visits). Wasp nest $150–$300. Bedbug treatment $500–$1,500.
Guarantee: Most treatments include a 30–90 day guarantee.

=== CLEANING SERVICES ===
Services: Regular house cleaning, deep cleaning, move-in/move-out, post-renovation cleanup, carpet cleaning, window washing, commercial cleaning.
Pricing: Regular clean (avg home) $120–$250. Deep clean $250–$500. Move-out clean $300–$600. Carpet cleaning $150–$400.

=== POOL & HOT TUB ===
Services: Opening/closing (seasonal), maintenance, repair, water balancing, equipment repair (pumps, heaters, filters), hot tub service.
Pricing: Pool opening $300–$600. Hot tub service call $100–$200. Seasonal maintenance package $500–$1,500.
Season: Pool season May–September in Edmonton.

=== SNOW REMOVAL ===
Services: Driveway/sidewalk clearing, commercial lots, sanding/salting, seasonal contracts, one-time service.
Pricing: Per visit residential $40–$80. Seasonal contract $600–$1,500. Commercial varies.
Season: November–March. Contracts fill up by October — book early.

=== TREE SERVICE ===
Services: Tree removal, trimming/pruning, stump grinding, emergency storm damage, tree health assessment, shrub removal.
Pricing: Tree trimming $300–$1,500. Tree removal $500–$3,000+. Stump grinding $150–$400. Emergency call available.
Edmonton-specific: City of Edmonton has rules on removing trees over a certain size — we handle all permits.

=== FLOORING ===
Services: Hardwood install/refinish, laminate, LVP/vinyl plank, tile, carpet, subfloor repair, stair nosing.
Pricing: Hardwood install $8–$15/sq ft. LVP $5–$10/sq ft. Tile $10–$20/sq ft. Carpet $4–$8/sq ft. Refinish hardwood $3–$6/sq ft.

=== DRYWALL ===
Services: New installation, patching/repair (holes, water damage, cracks), taping and mudding, texture matching, soundproofing.
Pricing: Patch repair $100–$300. Full room $1–$3/sq ft. Basement (1,000 sq ft) $2,000–$5,000.

=== INSULATION ===
Services: Attic insulation (blown-in, batt), wall insulation, spray foam, basement insulation, soundproofing.
Pricing: Attic blown-in $1,500–$4,000. Spray foam $1–$3/sq ft. Alberta rebates available for upgrading insulation.
Edmonton-specific: Recommended R-60 in attic for Edmonton climate. Rebates up to $2,400 through Empower Me / Efficiency Alberta.

=== CONCRETE ===
Services: Driveway replacement/repair, sidewalks, garage floor, steps, patios, decorative concrete, crack repair, sealing.
Pricing: Driveway replace $5,000–$15,000. Patio $3,000–$8,000. Crack repair $200–$800. Sealing $300–$800.
Season: Poured concrete April–October (no pours below 5°C).

=== FENCING ===
Services: Wood fence, vinyl fence, chain link, aluminum/ornamental, fence repair, post replacement, gates.
Pricing: Wood fence $25–$50/linear ft installed. Vinyl $35–$65/linear ft. Chain link $20–$40/linear ft. Gate $500–$2,000.
Edmonton-specific: Property lines must be confirmed before install. Permits required for fences over 1.85m.
`;

// ── Build system prompt ────────────────────────────────────────────────────────
function buildSystemPrompt(config = {}) {
  const bizName = config.bizName || "the business";
  const trade = config.trade || "trades";
  const callout = config.callout || null;
  const job1 = config.job1 || null;
  const job2 = config.job2 || null;
  const hours = config.hours || "Mon–Fri 8am–5pm, Sat 9am–1pm";
  const area = config.area || "Edmonton and surrounding area";
  const ownerName = process.env.OWNER_NAME || "Jordan";
  const ownerPhone = process.env.OWNER_PHONE || "587-568-7784";

  let customPricing = "";
  if (callout || job1 || job2) {
    customPricing = `\nCUSTOM PRICING FOR THIS BUSINESS (always use these exact numbers):`;
    if (callout) customPricing += `\n- Service/callout fee: ${callout}`;
    if (job1) customPricing += `\n- ${job1}`;
    if (job2) customPricing += `\n- ${job2}`;
    customPricing += `\n- Always say "all pricing is confirmed on-site, no surprises"\n`;
  }

  const customFaq = config.faq
    ? `\nCUSTOM Q&A (use these exact answers — do NOT improvise or add to these):
${config.faq}
If a customer asks something covered above, use only the answer provided. Do not add extra information.\n`
    : "";

  return `You are the AI booking assistant for ${bizName}, a ${trade} company serving ${area}. You represent ${bizName} — never mention SwiftBot, Swiftbooked, or any third-party service. To the customer, you are simply ${bizName}.

YOUR PRIMARY JOB:
Respond to leads, answer their questions, and book them an appointment — all via text or web chat. You are the first impression of ${bizName}. Be warm, efficient, and professional.

BUSINESS HOURS: ${hours}
SERVICE AREA: ${area}
${customPricing}${customFaq}

YOUR PERSONALITY:
- Friendly, local, and knowledgeable — you know Edmonton well
- Conversational and concise — SMS only, keep it tight, one idea per message
- Never robotic or scripted-sounding
- Acknowledge urgency immediately (no heat at -30°C = drop everything)
- If they share their neighbourhood, use it ("We service Sherwood Park all the time")
- Never say "As an AI" or reveal you're automated unless directly asked

BOOKING FLOW — collect in this order, naturally:
1. Understand their problem / service needed
2. Get their address or neighbourhood
3. Check urgency (today? this week? emergency?)
4. Offer 2 time slots (generate realistic ones based on business hours and current context)
5. Get their first name to confirm
6. Confirm with booking ID (format: BK + 4 random alphanumeric, e.g. BK4F2X)
7. Tell them a tech will call 30 min before arrival

TIME SLOT GENERATION (since you don't have live calendar access in demo mode):
- If urgent/today: offer today's afternoon or earliest tomorrow morning
- Standard: offer 2 slots within the next 3 business days
- Always use 2-hour windows (e.g. "2pm–4pm")
- Be specific with dates ("Thursday April 24" not "next Thursday")

AFTER-HOURS / EMERGENCY:
- Mention $150 emergency surcharge for after-hours calls
- Gas leaks: "Stop — if you smell gas, leave the building and call ATCO Gas at 1-800-511-3447. We'll meet you there."
- Active flooding: "Shut off your main water valve (usually in utility room) and we'll get there ASAP."

PRICE QUESTIONS:
- Use the custom pricing above if provided
- Otherwise use the trade knowledge base pricing ranges below
- Always say "exact quote provided on-site after assessment"
- Never say you don't know pricing — give a realistic range

WARRANTY / GUARANTEE:
- All work comes with a 1-year labour warranty
- Parts covered by manufacturer warranty (usually 1–5 years)
- "We stand behind everything we do"

LICENSING:
- All technicians are licensed and insured
- We pull all required permits

PAYMENTS:
- We accept cash, e-transfer, Visa, Mastercard
- Payment due on completion

RESPONSE TO "ARE YOU A ROBOT?":
Say something like: "Ha — I'm an AI assistant that handles the booking side so you get an instant response any time of day. A real tech shows up at your door. Want to get something scheduled?"

IF YOU CANNOT HELP:
Escalate: "I want to make sure you get the right help — let me flag this for our team and someone will call you within the hour."

${TRADES_KNOWLEDGE}

IMPORTANT RULES:
- Never make up a booking ID or confirm a slot without going through the full flow
- Never share customer data from other conversations
- Keep responses SHORT — 1 to 2 sentences max, ideally under 140 characters. This is SMS, not email.
- Never list multiple things in one message — ask one question at a time
- End every reply with a single clear question or next step
- Today's date context: use realistic upcoming dates for time slots`;
}

// ── Tool definitions ───────────────────────────────────────────────────────────
const tools = [
  {
    name: "confirm_booking",
    description:
      "Call this when the customer has agreed to a specific time slot and provided their name. Creates a confirmed booking and calendar event.",
    input_schema: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Customer's first name" },
        service_type:  { type: "string", description: "What service is needed" },
        time_slot:     { type: "string", description: 'Human-readable slot, e.g. "Thursday April 24, 2pm–4pm"' },
        date:          { type: "string", description: "ISO date YYYY-MM-DD, e.g. 2026-04-24" },
        start_time:    { type: "string", description: "24h start time HH:MM, e.g. 14:00" },
        end_time:      { type: "string", description: "24h end time HH:MM, e.g. 16:00" },
        address:       { type: "string", description: "Customer address or neighbourhood" },
        is_emergency:  { type: "boolean", description: "Is this an emergency/after-hours call?" },
      },
      required: ["customer_name", "service_type", "time_slot", "date", "start_time", "end_time"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Use when the situation is dangerous (gas leak, flooding), the customer is upset, or the job is too complex to handle via chat.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        urgency: {
          type: "string",
          enum: ["immediate", "within_hour", "when_free"],
        },
        summary: { type: "string", description: "Brief summary for the owner" },
      },
      required: ["reason", "urgency", "summary"],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput, context = {}) {
  switch (toolName) {
    case "confirm_booking": {
      const bookingId = "BK" + Math.random().toString(36).substring(2, 6).toUpperCase();
      const emergency = toolInput.is_emergency;

      let calendarBooked = false;
      if (context.googleRefreshToken && toolInput.date && toolInput.start_time && toolInput.end_time) {
        try {
          await createBookingEvent(context.googleRefreshToken, {
            summary: `${emergency ? "⚡ EMERGENCY: " : ""}${toolInput.service_type} — ${toolInput.customer_name}`,
            description: [
              `Booking ID: ${bookingId}`,
              `Customer: ${toolInput.customer_name}`,
              `Phone: ${context.customerPhone || "Unknown"}`,
              `Address: ${toolInput.address || "TBD"}`,
              emergency ? "⚠️ EMERGENCY — after-hours surcharge applies" : null,
            ].filter(Boolean).join("\n"),
            date: toolInput.date,
            startTime: toolInput.start_time,
            endTime: toolInput.end_time,
          });
          calendarBooked = true;
          console.log(`[Calendar] Booked ${bookingId} for ${context.bizName || "client"}`);
        } catch (err) {
          console.error(`[Calendar] Failed to create event:`, err.message);
        }
      }

      return {
        success: true,
        booking_id: bookingId,
        calendar_booked: calendarBooked,
        customer_name: toolInput.customer_name,
        service: toolInput.service_type,
        slot: toolInput.time_slot,
        address: toolInput.address || "To be confirmed",
        surcharge: emergency ? "$150 after-hours surcharge applies" : null,
        next_step: "Tech will call 30 minutes before arrival",
      };
    }

    case "escalate_to_human": {
      const ownerPhone = process.env.OWNER_PHONE || "587-568-7784";
      console.log(
        `[ESCALATE - ${toolInput.urgency}] ${toolInput.reason}\n${toolInput.summary}`
      );
      return {
        escalated: true,
        owner_notified: true,
        owner_phone: ownerPhone,
        message: "Owner has been alerted and will contact you directly.",
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Main chat handler ─────────────────────────────────────────────────────────
export async function handleChat(sessionId, userMessage, config = {}) {
  // Load or create session
  let session = sessions.get(sessionId) || {
    messages: [],
    config,
    startedAt: new Date().toISOString(),
    booked: false,
    bookingId: null,
  };

  // Update config if provided (first message of session)
  if (config && Object.keys(config).length > 0) {
    session.config = { ...session.config, ...config };
  }

  // Handle greeting trigger from demo widget
  const isGreeting = userMessage === "__greeting__";
  const actualMessage = isGreeting
    ? `Send a warm, natural opening text message as ${session.config.bizName || "the business"}. Say something like "Hi, this is [business name] — how can we help you today?" Keep it to 1 sentence. Do not mention SwiftBot or Swiftbooked.`
    : userMessage;

  // Add user message
  session.messages.push({ role: "user", content: actualMessage });

  try {
    let finalText = null;
    let iterations = 0;
    const MAX = 6;

    while (!finalText && iterations < MAX) {
      iterations++;

      const response = await client.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 512,
        system: buildSystemPrompt(session.config),
        tools,
        messages: session.messages,
      });

      if (response.stop_reason === "tool_use") {
        session.messages.push({ role: "assistant", content: response.content });

        const toolResults = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            const result = await executeTool(block.name, block.input, session.config);

            if (block.name === "confirm_booking" && result.success) {
              session.booked = true;
              session.bookingId = result.booking_id;
            }

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          }
        }

        session.messages.push({ role: "user", content: toolResults });
      } else {
        finalText = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");

        session.messages.push({ role: "assistant", content: finalText });
      }
    }

    sessions.set(sessionId, session);

    return {
      reply: finalText,
      booked: session.booked,
      bookingId: session.bookingId,
      messageCount: session.messages.filter((m) => m.role === "user").length,
    };
  } catch (err) {
    console.error("[AI Engine Error]", err.message);
    throw err;
  }
}

// ── SMS handler (Twilio) ──────────────────────────────────────────────────────
export async function handleIncomingMessage(phone, text, name = null, clientConfig = null) {
  const config = clientConfig || {
    bizName: process.env.BUSINESS_NAME || "the business",
    trade:   process.env.BUSINESS_TYPE || "trades",
    hours:   process.env.BUSINESS_HOURS || "Mon–Fri 8am–5pm, Sat 9am–1pm",
    area:    process.env.SERVICE_AREA || "Edmonton and surrounding area",
  };
  if (name) config.customerName = name;

  return await handleChat(`sms_${phone}`, text, config);
}

export function clearSession(sessionId) {
  sessions.delete(sessionId);
}

export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

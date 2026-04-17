# Trades Lead Bot
**AI lead response & booking automation for Edmonton trades companies**

Responds to new leads in under 2 minutes, qualifies them, and books an appointment — all via SMS, 24/7, without a human touching it.

---

## What it does

1. **Catches every lead** — missed calls (via Twilio), web forms, Google Local Services Ads
2. **Responds instantly** — AI texts back within seconds, personalized to the job type
3. **Qualifies & books** — asks the right questions, checks real calendar availability, confirms the appointment
4. **Notifies the owner** — sends a summary email/Slack when a job is booked
5. **Escalates when needed** — gas leaks, floods, complex jobs → hands off to a human immediately

---

## Quick Start (Demo Mode)

```bash
# 1. Install
git clone <this-repo>
cd trades-lead-bot
npm install

# 2. Configure
cp .env.example .env
# Edit .env — add at minimum:
#   ANTHROPIC_API_KEY=your_key
#   BUSINESS_NAME="Your Company"
#   BUSINESS_TYPE=hvac  (or plumbing, electrical, construction)

# 3. Run the interactive demo
npm run demo
```

The demo runs a full AI conversation in your terminal — no Twilio or Google Calendar needed.

---

## Production Setup

### Step 1: Twilio (SMS)

1. Sign up at [twilio.com](https://twilio.com) — get an Edmonton area code (780 or 587)
2. Cost: ~$1.15/mo for the number + $0.0075/SMS
3. Add to `.env`:
   ```
   TWILIO_ACCOUNT_SID=ACxxxxxxxx
   TWILIO_AUTH_TOKEN=xxxxxxxx
   TWILIO_PHONE_NUMBER=+17804440000
   ```
4. In Twilio console → Phone Numbers → your number → Messaging webhook:
   ```
   https://yourdomain.com/webhook/sms
   ```

### Step 2: Google Calendar

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create project → Enable Google Calendar API
3. Create OAuth2 credentials → get Client ID + Secret
4. Run the OAuth flow once to get a refresh token:
   ```bash
   node scripts/get-google-token.js
   ```
5. Add to `.env`:
   ```
   GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxxx
   GOOGLE_REFRESH_TOKEN=xxxxx
   GOOGLE_CALENDAR_ID=primary
   ```

### Step 3: Website Form Integration

Add this to your contact form's submission handler:

```javascript
// Example: plain HTML form
fetch('https://yourdomain.com/webhook/form', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: formData.get('name'),
    phone: formData.get('phone'),
    service: formData.get('service'),
    message: formData.get('message')
  })
});
```

For **WordPress + Gravity Forms**, use the webhook add-on and point it at `/webhook/form`.

### Step 4: Deploy

```bash
# Option A: Railway (easiest, ~$5/mo)
npm install -g @railway/cli
railway login
railway init
railway up

# Option B: DigitalOcean App Platform
# Connect your GitHub repo, set env vars in dashboard

# Option C: VPS (Hetzner, Linode)
npm install -g pm2
pm2 start src/server.js --name trades-bot
pm2 save
```

---

## Conversation Flow

```
Customer texts → AI responds in <30 seconds

Turn 1:  "My furnace is broken, it's -30 outside"
Bot:     "Hi! This is Apex Heating. Sorry to hear that — sounds urgent.
          Can I get your address so we can get someone out today?"

Turn 2:  "123 Whyte Ave"
Bot:     "Got it. We have a tech available today between 2pm–4pm or
          tomorrow 8am–10am. Which works for you?"

Turn 3:  "Today please"
Bot:     "Perfect. Can I get your name to confirm the booking?"

Turn 4:  "Mike"
Bot:     "Booked! Mike — Thursday Nov 14, 2pm–4pm. Booking #BK4F2X.
          Your tech will call 30 min before arrival.
          Questions? Call 780-444-1234."

→ Google Calendar event created
→ Owner notified by email
→ Mike gets a reminder SMS the morning of
```

---

## Customizing the AI Personality

Edit `src/ai-engine.js` → `buildSystemPrompt()`:

- Change the tone (more casual, more formal)
- Add specific services you offer
- Add pricing FAQs (e.g. "service call fee is $X")
- Add local knowledge (neighbourhoods you don't service, etc.)
- Change booking windows (evenings, weekends)

---

## Business Types

Set `BUSINESS_TYPE` in `.env` to customize the AI's knowledge:

| Value | Services |
|-------|----------|
| `hvac` | Furnace, AC, boiler, duct cleaning |
| `plumbing` | Leaks, drains, water heaters, sewer |
| `electrical` | Panels, circuits, EV chargers |
| `construction` | Renovations, basements, decks |

---

## Measuring Results (For Your Commission Model)

The bot logs every conversation. Track these metrics:

```javascript
// Add to your database to track commission:
{
  lead_source: "web_form",       // where it came from
  lead_received_at: timestamp,   // when lead came in
  first_response_at: timestamp,  // should be <2min
  booked: true,                  // did it convert?
  booking_id: "BK4F2X",
  job_value: null,               // fill in after job completes
  commission_amount: null        // 10-15% of job value
}
```

Build a simple dashboard in Claude Code to track your monthly commission across all clients.

---

## Files

```
trades-lead-bot/
├── src/
│   ├── server.js        — Express server, all webhooks
│   ├── ai-engine.js     — Claude conversation engine (main logic)
│   ├── calendar.js      — Google Calendar integration
│   └── demo.js          — Interactive terminal demo
├── .env.example         — All config variables
├── package.json
└── README.md
```

---

## Edmonton-Specific Notes

- **-35°C winter nights**: The AI is primed to recognize furnace emergencies and fast-track them
- **Oilers game days**: Consider blocking 6–10pm on game days (staff book off — add to Google Calendar)
- **Area codes**: Get a 780 number — locals trust it more than toll-free
- **French language**: ~5% of Edmonton residents are francophone — add French handling if needed

---

## License

MIT — use freely, sell freely, build your business.

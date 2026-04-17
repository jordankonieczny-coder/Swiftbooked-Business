import { useState, useRef, useEffect } from "react";

const BUSINESS = {
  name: "Apex Heating & Plumbing",
  type: "hvac",
  phone: "780-444-1234",
};

const SYSTEM_PROMPT = `You are an AI booking assistant for ${BUSINESS.name}, a trades company in Edmonton, Alberta.

You respond to new leads via SMS. Your job: qualify the lead and book an appointment.

PERSONALITY: Friendly, local, concise (SMS-style). You know Edmonton.

SERVICES: Furnace repair/replacement, AC service, boiler maintenance, water heater service, plumbing repairs, drain clearing.

CONVERSATION GOALS:
1. Warm acknowledgment
2. Identify service needed
3. Get their address/neighbourhood
4. Assess urgency (emergency vs scheduled)
5. Offer 2 specific time slots
6. Collect their name
7. Confirm booking with ID

BOOKING RULES:
- Regular hours: Mon-Fri 8am-5pm, Sat 9am-1pm (Mountain Time)
- Emergency/after-hours: available but $150 surcharge
- Always offer earliest available first for urgent requests
- 2-hour service windows

IMPORTANT: Keep responses SHORT — this is SMS. Under 160 characters when possible. Be warm but efficient.
Never quote job prices. For gas leaks: tell them to call 911 and evacuate immediately.

Generate realistic available time slots based on today being a weekday in Edmonton.
When they confirm a booking, generate a booking ID like BK followed by 4 alphanumeric characters.`;

const SUGGESTED_MESSAGES = [
  "My furnace stopped working, it's -28 outside 😰",
  "Hi found you on Google, need a plumber my basement drain is backing up",
  "Need someone to look at my water heater it's making a loud banging noise",
  "AC not working and it's 32 degrees in my house in Windermere",
];

export default function TradesLeadDemo() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [booked, setBooked] = useState(false);
  const [bookingId, setBookingId] = useState(null);
  const [history, setHistory] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = async (text) => {
    const userText = text || input.trim();
    if (!userText || loading) return;

    setInput("");
    setShowSuggestions(false);

    const newMessages = [...messages, { role: "customer", text: userText, time: now() }];
    setMessages(newMessages);

    const newHistory = [...history, { role: "user", content: userText }];
    setHistory(newHistory);
    setLoading(true);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 300,
          system: SYSTEM_PROMPT,
          messages: newHistory,
        }),
      });

      const data = await response.json();
      const reply = data.content?.[0]?.text || "Sorry, I couldn't process that. Please call us at " + BUSINESS.phone;

      const updatedHistory = [...newHistory, { role: "assistant", content: reply }];
      setHistory(updatedHistory);

      // Detect booking confirmation
      const isBooked = /booking #|booked!|confirmed|appointment is set/i.test(reply);
      const idMatch = reply.match(/BK[A-Z0-9]{4}/i);

      if (isBooked) {
        setBooked(true);
        if (idMatch) setBookingId(idMatch[0]);
      }

      setMessages([...newMessages, { role: "bot", text: reply, time: now(), booked: isBooked }]);
    } catch (err) {
      setMessages([...newMessages, {
        role: "bot",
        text: `Sorry, demo error: ${err.message}. In production this would send via SMS.`,
        time: now(),
        error: true
      }]);
    }

    setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const reset = () => {
    setMessages([]);
    setHistory([]);
    setInput("");
    setBooked(false);
    setBookingId(null);
    setShowSuggestions(true);
  };

  return (
    <div style={{
      fontFamily: "'Georgia', serif",
      background: "var(--color-background-tertiary)",
      minHeight: "600px",
      borderRadius: "16px",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Header */}
      <div style={{
        background: "var(--color-background-primary)",
        borderBottom: "0.5px solid var(--color-border-tertiary)",
        padding: "14px 18px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: "50%",
          background: "var(--color-background-info)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 18,
        }}>🔥</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 500, color: "var(--color-text-primary)" }}>
            {BUSINESS.name}
          </div>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--color-text-success)", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }}/>
            AI responds in &lt;30 seconds · 24/7
          </div>
        </div>
        <div style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--color-text-tertiary)", textAlign: "right" }}>
          <div>Edmonton, AB</div>
          <div>{BUSINESS.phone}</div>
        </div>
      </div>

      {/* Booking banner */}
      {booked && (
        <div style={{
          background: "var(--color-background-success)",
          borderBottom: "0.5px solid var(--color-border-tertiary)",
          padding: "10px 18px",
          display: "flex", alignItems: "center", gap: 8,
          fontFamily: "var(--font-sans)", fontSize: 13,
          color: "var(--color-text-success)",
        }}>
          <span style={{ fontSize: 16 }}>✓</span>
          <span style={{ fontWeight: 500 }}>Appointment booked{bookingId ? ` — ${bookingId}` : ""}!</span>
          <span style={{ color: "var(--color-text-secondary)", marginLeft: 4 }}>Calendar event created · Owner notified</span>
        </div>
      )}

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        minHeight: 320,
      }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", padding: "32px 16px" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📱</div>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 14, color: "var(--color-text-secondary)", marginBottom: 6 }}>
              This is what your customer sees
            </div>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--color-text-tertiary)" }}>
              Text in as a customer — the AI books the appointment
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{
            display: "flex",
            flexDirection: "column",
            alignItems: msg.role === "customer" ? "flex-end" : "flex-start",
            marginTop: i > 0 && messages[i-1].role !== msg.role ? 10 : 2,
          }}>
            {i === 0 || messages[i-1].role !== msg.role ? (
              <div style={{
                fontFamily: "var(--font-sans)", fontSize: 11,
                color: "var(--color-text-tertiary)",
                marginBottom: 3,
                paddingLeft: msg.role === "bot" ? 8 : 0,
                paddingRight: msg.role === "customer" ? 8 : 0,
              }}>
                {msg.role === "customer" ? "You" : BUSINESS.name + " AI"} · {msg.time}
              </div>
            ) : null}
            <div style={{
              maxWidth: "78%",
              padding: "9px 13px",
              borderRadius: msg.role === "customer"
                ? "18px 18px 4px 18px"
                : "18px 18px 18px 4px",
              background: msg.role === "customer"
                ? "var(--color-background-info)"
                : msg.booked
                  ? "var(--color-background-success)"
                  : "var(--color-background-primary)",
              border: "0.5px solid var(--color-border-tertiary)",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              lineHeight: 1.5,
              color: msg.error ? "var(--color-text-danger)" : "var(--color-text-primary)",
              whiteSpace: "pre-wrap",
            }}>
              {msg.text}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: "flex", alignItems: "flex-start", marginTop: 10 }}>
            <div style={{
              padding: "10px 14px",
              borderRadius: "18px 18px 18px 4px",
              background: "var(--color-background-primary)",
              border: "0.5px solid var(--color-border-tertiary)",
              display: "flex", gap: 4, alignItems: "center",
            }}>
              {[0,1,2].map(i => (
                <div key={i} style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "var(--color-text-tertiary)",
                  animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
                }}/>
              ))}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Suggestions */}
      {showSuggestions && (
        <div style={{
          padding: "8px 18px",
          display: "flex", gap: 6, flexWrap: "wrap",
        }}>
          {SUGGESTED_MESSAGES.map((s, i) => (
            <button key={i} onClick={() => sendMessage(s)} style={{
              fontFamily: "var(--font-sans)", fontSize: 12,
              padding: "5px 10px",
              borderRadius: 99,
              border: "0.5px solid var(--color-border-secondary)",
              background: "var(--color-background-primary)",
              color: "var(--color-text-secondary)",
              cursor: "pointer",
              textAlign: "left",
              maxWidth: 200,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{
        padding: "12px 18px",
        background: "var(--color-background-primary)",
        borderTop: "0.5px solid var(--color-border-tertiary)",
        display: "flex", gap: 8, alignItems: "flex-end",
      }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          placeholder="Text as a customer…"
          rows={1}
          style={{
            flex: 1, resize: "none",
            fontFamily: "var(--font-sans)", fontSize: 14,
            padding: "9px 12px",
            border: "0.5px solid var(--color-border-secondary)",
            borderRadius: 20,
            background: "var(--color-background-secondary)",
            color: "var(--color-text-primary)",
            outline: "none",
            lineHeight: 1.4,
          }}
        />
        <button
          onClick={() => sendMessage()}
          disabled={!input.trim() || loading}
          style={{
            width: 36, height: 36, borderRadius: "50%",
            background: input.trim() && !loading ? "var(--color-background-info)" : "var(--color-background-secondary)",
            border: "0.5px solid var(--color-border-tertiary)",
            cursor: input.trim() && !loading ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, flexShrink: 0,
            transition: "background 0.2s",
          }}
        >↑</button>
        {messages.length > 0 && (
          <button onClick={reset} style={{
            fontFamily: "var(--font-sans)", fontSize: 12,
            padding: "8px 12px", borderRadius: 20,
            border: "0.5px solid var(--color-border-secondary)",
            background: "transparent",
            color: "var(--color-text-tertiary)",
            cursor: "pointer", flexShrink: 0,
          }}>
            Reset
          </button>
        )}
      </div>

      <style>{`
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}

function now() {
  return new Date().toLocaleTimeString("en-CA", {
    timeZone: "America/Edmonton",
    hour: "2-digit", minute: "2-digit",
  });
}

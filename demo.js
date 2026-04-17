/**
 * Interactive demo — runs a full AI conversation in your terminal.
 * Simulates a homeowner texting in about a furnace issue.
 *
 * Run with: node src/demo.js
 * (Requires ANTHROPIC_API_KEY in .env)
 */

import "dotenv/config";
import readline from "readline";
import { handleIncomingMessage } from "./ai-engine.js";

// Override env for demo mode
process.env.NODE_ENV = "demo";
process.env.BUSINESS_NAME = process.env.BUSINESS_NAME || "Apex Heating & Plumbing";
process.env.BUSINESS_TYPE = process.env.BUSINESS_TYPE || "hvac";
process.env.BUSINESS_PHONE = process.env.BUSINESS_PHONE || "+17804441234";

const DEMO_PHONE = "+17804550001";

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

function c(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

function printMessage(role, text) {
  const timestamp = new Date().toLocaleTimeString("en-CA", {
    timeZone: "America/Edmonton",
    hour: "2-digit",
    minute: "2-digit",
  });

  if (role === "customer") {
    console.log(`\n${c("gray", timestamp)} ${c("yellow", "📱 Customer")}:`);
    console.log(`  ${c("yellow", text)}`);
  } else {
    console.log(`\n${c("gray", timestamp)} ${c("cyan", `🤖 ${process.env.BUSINESS_NAME} AI`)}:`);
    console.log(`  ${c("green", text)}`);
  }
}

async function runDemo() {
  console.clear();
  console.log(c("bold", "\n╔══════════════════════════════════════════════════╗"));
  console.log(c("bold",   "║   Trades Lead Bot — Live Demo                    ║"));
  console.log(c("bold",   "║   Simulating SMS conversation (Edmonton timezone) ║"));
  console.log(c("bold",   "╚══════════════════════════════════════════════════╝\n"));
  console.log(c("gray", `Business: ${process.env.BUSINESS_NAME} (${process.env.BUSINESS_TYPE})`));
  console.log(c("gray", "Customer phone: " + DEMO_PHONE));
  console.log(c("gray", "\nType messages as the customer. Press Ctrl+C to exit.\n"));
  console.log(c("gray", "─".repeat(52)));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = (prompt) =>
    new Promise((resolve) => rl.question(prompt, resolve));

  // Auto-start with a common lead scenario
  const scenarios = [
    "Hi, my furnace stopped working and its -25 outside. Can someone come today?",
    "Hello I found you on Google, I need a plumber my basement is flooding",
    "Need an electrician to install an EV charger in my garage in Windermere",
  ];

  console.log(c("gray", "\nQuick start scenarios (or type your own):"));
  scenarios.forEach((s, i) => console.log(c("gray", `  ${i + 1}. ${s}`)));
  console.log();

  while (true) {
    const input = await askQuestion(c("yellow", "Customer: "));

    if (!input.trim()) continue;
    if (input.toLowerCase() === "quit" || input.toLowerCase() === "exit") break;

    // Check if they picked a scenario number
    const scenarioNum = parseInt(input.trim());
    const message =
      scenarioNum >= 1 && scenarioNum <= scenarios.length
        ? scenarios[scenarioNum - 1]
        : input.trim();

    printMessage("customer", message);

    process.stdout.write(c("gray", "\n  [AI thinking...] "));
    const startTime = Date.now();

    try {
      const result = await handleIncomingMessage(DEMO_PHONE, message);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // Clear the thinking indicator
      process.stdout.write("\r" + " ".repeat(20) + "\r");

      printMessage("bot", result.message);
      console.log(c("gray", `\n  [Response time: ${elapsed}s | Messages: ${result.conversationLength} | Booked: ${result.booked}]`));

      if (result.booked) {
        console.log(c("green", "\n  ✓ APPOINTMENT BOOKED! Booking ID: " + result.bookingId));
        console.log(c("green", "  In production: Calendar event created + owner notified\n"));
      }
    } catch (err) {
      process.stdout.write("\r" + " ".repeat(20) + "\r");
      console.error(c("gray", `\n  [Error: ${err.message}]`));

      if (err.message?.includes("API key")) {
        console.error(c("yellow", "\n  → Add your ANTHROPIC_API_KEY to .env and try again"));
        break;
      }
    }
  }

  console.log(c("gray", "\n\nDemo ended. Full conversation summary:"));
  rl.close();
}

runDemo().catch(console.error);

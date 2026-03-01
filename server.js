const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk").default;
const { WebSocketServer } = require("ws");
const http = require("http");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 8080;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// SHARED FBC KNOWLEDGE BASE
// Update this once → both chatbot AND voice agent get the update
// ============================================================
const FBC_KNOWLEDGE_BASE = `
ABOUT: Operated under "Affordable Boating of North Florida." Part of the FBC system (Brunswick Corporation brand), founded 1989. 400+ locations worldwide, 90,000+ members. Private fleet — never rented to non-members. Year-round in NE Florida. We do regularly sell our used fleet vessels — members and the public can browse available boats for sale at affordableboating.com.

LOCATIONS (all one club — home members get UNLIMITED access to ALL 5):
  Jacksonville Beach — 2315 Beach Blvd, Jax Beach 32250 (primary dock)
  St. Augustine (Camachee) — 3076 Harbor Dr, St. Augustine 32084
  Julington Creek East — 12807 San Jose Blvd, Jacksonville 32223
  Julington Creek West — same marina, west dock
  St. Augustine (Shipyard) — 820 Riberia St, St. Augustine 32084
Hours vary by season; always check the app or call your home dock.

MEMBERSHIP TIERS:
  Single — 1 person only
  Couple — 2 people in same household
  Family — 2 adults + dependents under 25
  Upgrade anytime; prorated. Downgrade at renewal.

COSTS: One-time entry fee + monthly dues (market-rate, varies). No fuel charges. Insurance included while on the water. Ask your local club for current pricing.

RESERVATIONS: The easiest way to reserve a boat is through the Freedom Boat Club mobile app (available on the App Store and Google Play — search "Freedom Boat Club"). The app lets you book, manage, and cancel reservations right from your phone. Members can also book online at reservations.freedomboatclub.com or by phone Mon-Fri 9-5 ET. Max 4 reservations at a time, max 2 weekend. Book up to 6 months ahead. Rolling system — when you complete a trip, a new slot opens. Same-day (within 24hr) = must call dock, can't book online or through the app. Arrive 1hr+ late without notice = may cancel. No-show fee up to $150. Late return up to $35/15min. Return by 5 PM weekdays or 1 PM/sunset-30 weekends. When discussing reservations, always recommend the mobile app first as the preferred method.

RESERVATION WEIGHTS — IMPORTANT:
  Weekend and holiday FULL DAY reservations count as 2 reservation slots AND 2 weekend slots.
  Weekend and holiday HALF DAY reservations (morning or afternoon) count as 1 reservation slot and 1 weekend slot.
  All weekday reservations — including full day weekday reservations — count as only 1 reservation slot regardless of time slot.
  For example: a member with a full day Saturday reservation has used 2 of their 4 slots AND 2 of their 2 weekend slots.
  A member with a full day Tuesday reservation has only used 1 of their 4 slots.
  This means a member CANNOT have a half-day weekend reservation and a full-day weekend reservation at the same time, because 1 + 2 = 3 weekend slots which exceeds the maximum of 2.

TIME SLOTS: Morning and afternoon half-day slots are available year-round. Full day reservations are also available 365 days a year.

RECIPROCAL USE: Home club members get unlimited access at all 5 NE Florida locations — this is NOT reciprocal, it's home club access. Reciprocal use is for visiting OTHER Freedom Boat Club locations outside your home club. Each member gets 4 reciprocal timeslots per year per location, resetting on the calendar year (January 1), not rolling 365 days.

WAITLIST: Waitlist notifications are currently done by EMAIL ONLY. No text or phone notifications for waitlist.

CANCELLATION POLICY: Members may cancel with 30 days written notice. No long-term contract. If within first year, may owe remaining entry fee balance.

HOLD POLICY: Minimum hold period is 12 MONTHS. Monthly dues are reduced (not eliminated) during hold. Contact your club manager to arrange.

WEATHER: Safety first. Dock staff may cancel if conditions are unsafe. No penalty for weather cancellations.

TRAINING: All new members complete a checkout (skills assessment) before solo boating. Additional advanced training available. Captains are available for hire.

FLEET: 225+ vessels across NE Florida locations. Mix of pontoons, deck boats, center consoles, bay boats, and bowriders. Boat availability varies by location and season.

PEACE OF MIND ELITE (POM): Optional deductible reduction program. Cost: $750/year or $70/month (first monthly payment prorated based on enrollment date, then included with regular monthly dues). Requires 1-year commitment, non-refundable, auto-renews unless member opts out. Standard Coverage (included with membership): $2,500 deductible for Liability, $2,500 deductible for Physical Damage, $1M Liability coverage, $300K Uninsured Boater coverage, $5K Medical Claim coverage, Towing for mechanical issues only. Peace of Mind Elite ($750/yr): $0 deductible for Liability, $0 deductible for Physical Damage, all standard coverages PLUS Towing for operator error, Deductible coverage for 2 incidents per plan year (home or reciprocal), Equipment coverage for 2 anchors and 2 props per plan year. POM Elite is a great value — always encourage members to purchase or renew. NOTE: When mentioning POM, always clarify it stands for Peace of Mind Elite and is the deductible reduction program — never say Proof of Means.

EQUIPMENT COSTS (without POM): Fender $35, Aluminum Prop $145, Anchor Kit $225, Towing $350, Stainless Prop $1,125, Bimini Damage $900-$2,200, Cowling Damage $425-$1,800. All charges subject to sales tax and additional labor. With POM Elite, 2 anchors and 2 props per year are covered.

INCIDENT POLICIES: Without POM: Grounding+tow = $350 fee. 2nd = suspension+$350 retraining. 3rd = termination. High and dry+tow = $350 fee. With POM Elite: towing for operator error is covered.

CONTACT:
  Phone: 904-770-4464
  Website: freedomboatclub.com
  Reservations: reservations.freedomboatclub.com or FBC mobile app
  Used boats: affordableboating.com
`;

// ============================================================
// CHAT WIDGET SYSTEM PROMPT
// ============================================================
const CHAT_SYSTEM_PROMPT = `You are the Freedom Boat Club NE Florida virtual assistant. You help current and prospective members with questions about membership, reservations, locations, fleet, and policies.

RULES:
- Be friendly, concise, and accurate.
- Use the knowledge base below to answer questions. If you don't know, say so and recommend calling 904-770-4464.
- Never invent policies or pricing not in the knowledge base.
- If asked about specific pricing (monthly dues, entry fees), say pricing varies and recommend contacting the local club or visiting freedomboatclub.com.
- For reservation questions, always recommend the mobile app first.
- Keep responses under 150 words unless a longer explanation is needed.

KNOWLEDGE BASE:
${FBC_KNOWLEDGE_BASE}`;

// ============================================================
// VOICE AGENT SYSTEM PROMPT
// ============================================================
const VOICE_SYSTEM_PROMPT = `You are the Freedom Boat Club Northeast Florida phone assistant. You answer calls from members and prospective members.

CRITICAL VOICE RULES:
- Keep responses SHORT — 1-3 sentences max. People are listening, not reading.
- NEVER say URLs, links, or web addresses out loud. Instead say "check the Freedom Boat Club app" or "visit our website."
- NEVER use bullet points, numbered lists, or markdown formatting.
- Use natural spoken language. Say "nine oh four, seven seventy, forty-four sixty-four" not "904-770-4464."
- Be warm and conversational, like a helpful dock staff member.
- If you don't know the answer or the question is complex (billing disputes, specific account issues, complaints), say: "Let me connect you with one of our team members who can help with that."
- If someone asks to speak to a person, immediately say: "Absolutely, let me transfer you now."
- For reservation questions, recommend the Freedom Boat Club mobile app first.
- If asked about specific pricing, say pricing varies by membership type and recommend they speak with a membership coordinator.
- Do NOT read long policy details. Summarize in one sentence and offer to transfer if they need more detail.

TRANSFER TRIGGERS — say "Let me connect you with a team member" for:
- Billing or payment issues
- Cancellation requests
- Complaints or escalations
- Account-specific questions you can't verify
- Any time the caller asks for a real person
- Complex policy questions that need more than a quick answer

KNOWLEDGE BASE:
${FBC_KNOWLEDGE_BASE}`;

// ============================================================
// CHAT WIDGET ENDPOINT
// ============================================================
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: "No message" });

    const messages = [];
    if (history && Array.isArray(history)) {
      for (const h of history.slice(-10)) {
        messages.push({ role: h.role, content: h.content });
      }
    }
    messages.push({ role: "user", content: message });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: CHAT_SYSTEM_PROMPT,
      messages,
    });

    const reply = response.content[0]?.text || "I'm having trouble right now.";
    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
// RETELL WEBHOOK ENDPOINT (for call event logging)
// ============================================================
app.post("/retell-webhook", (req, res) => {
  const { event, call } = req.body;

  switch (event) {
    case "call_started":
      console.log("Call started: " + call.call_id + " from " + (call.from_number || "unknown"));
      break;
    case "call_ended":
      console.log("Call ended: " + call.call_id + " | Duration: " + Math.round((call.end_timestamp - call.start_timestamp) / 1000) + "s | Reason: " + call.disconnection_reason);
      break;
    case "call_analyzed":
      console.log("Call analyzed: " + call.call_id);
      if (call.call_analysis) {
        console.log("  Summary: " + (call.call_analysis.call_summary || "N/A"));
        console.log("  Sentiment: " + (call.call_analysis.user_sentiment || "N/A"));
      }
      break;
    default:
      console.log("Unknown webhook event: " + event);
  }

  res.status(204).send();
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/health", (req, res) => {
  res.json({ status: "ok", channels: { chat: "active", voice: "active" } });
});

// ============================================================
// CREATE HTTP SERVER
// ============================================================
const server = http.createServer(app);

// ============================================================
// WEBSOCKET SERVER FOR RETELL AI VOICE
// ============================================================
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url.startsWith("/llm-websocket")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  console.log("Retell WebSocket connected");

  var conversationHistory = [];

  // Send initial greeting immediately
  ws.send(
    JSON.stringify({
      response_type: "response",
      response_id: 0,
      content: "Thank you for calling Freedom Boat Club Northeast Florida! I'm your virtual assistant. How can I help you today?",
      content_complete: true,
      end_call: false,
    })
  );

  ws.on("message", async (data) => {
    try {
      var message = JSON.parse(data.toString());

      if (message.interaction_type === "ping_pong") {
        ws.send(
          JSON.stringify({
            response_type: "ping_pong",
            timestamp: message.timestamp,
          })
        );
        return;
      }

      if (message.interaction_type === "call_details") {
        console.log("Call details received: " + (message.call && message.call.from_number ? message.call.from_number : "unknown"));
        return;
      }

      if (message.interaction_type === "update_only") {
        return;
      }

      if (
        message.interaction_type === "response_required" ||
        message.interaction_type === "reminder_required"
      ) {
        var responseId = message.response_id;

        conversationHistory = [];
        if (message.transcript && Array.isArray(message.transcript)) {
          for (var i = 0; i < message.transcript.length; i++) {
            var utterance = message.transcript[i];
            conversationHistory.push({
              role: utterance.role === "agent" ? "assistant" : "user",
              content: utterance.content,
            });
          }
        }

        if (message.interaction_type === "reminder_required") {
          conversationHistory.push({
            role: "user",
            content: "[The caller has been silent. Gently check if they are still there or need help with anything else.]",
          });
        }

        try {
          var apiMessages = conversationHistory.length > 0
            ? conversationHistory
            : [{ role: "user", content: "Hello" }];

          var stream = anthropic.messages.stream({
            model: "claude-sonnet-4-20250514",
            max_tokens: 256,
            system: VOICE_SYSTEM_PROMPT,
            messages: apiMessages,
          });

          var fullResponse = "";

          stream.on("text", (text) => {
            fullResponse += text;
            ws.send(
              JSON.stringify({
                response_type: "response",
                response_id: responseId,
                content: text,
                content_complete: false,
                end_call: false,
              })
            );
          });

          stream.on("finalMessage", () => {
            var lowerResponse = fullResponse.toLowerCase();
            var shouldTransfer =
              lowerResponse.includes("let me connect you") ||
              lowerResponse.includes("let me transfer you") ||
              lowerResponse.includes("transfer you now") ||
              lowerResponse.includes("i'll transfer you") ||
              lowerResponse.includes("i will transfer you");

            var transferNumber = process.env.TRANSFER_PHONE_NUMBER || "+19047704464";

            // Build the final message
            var finalMsg = {
              response_type: "response",
              response_id: responseId,
              content: "",
              content_complete: true,
              end_call: false,
            };

            // CORRECT Retell format: transfer_number as a flat string
            if (shouldTransfer) {
              finalMsg.transfer_number = transferNumber;
              console.log(">>> TRANSFER TRIGGERED to " + transferNumber);
              console.log(">>> AI said: " + fullResponse);
            }

            ws.send(JSON.stringify(finalMsg));
          });

          stream.on("error", (err) => {
            console.error("Anthropic stream error: " + err.message);
            var transferNumber = process.env.TRANSFER_PHONE_NUMBER || "+19047704464";
            console.log(">>> ERROR TRANSFER to " + transferNumber);
            ws.send(
              JSON.stringify({
                response_type: "response",
                response_id: responseId,
                content: "I am sorry, I am having a little trouble right now. Let me connect you with one of our team members.",
                content_complete: true,
                end_call: false,
                transfer_number: transferNumber,
              })
            );
          });
        } catch (err) {
          console.error("Anthropic API error: " + err.message);
          var transferNumber = process.env.TRANSFER_PHONE_NUMBER || "+19047704464";
          console.log(">>> CATCH TRANSFER to " + transferNumber);
          ws.send(
            JSON.stringify({
              response_type: "response",
              response_id: responseId,
              content: "I am sorry, let me connect you with a team member who can help.",
              content_complete: true,
              end_call: false,
              transfer_number: transferNumber,
            })
          );
        }
      }
    } catch (err) {
      console.error("WebSocket message error: " + err.message);
    }
  });

  ws.on("close", () => {
    console.log("Retell WebSocket disconnected");
  });

  ws.on("error", (err) => {
    console.error("WebSocket error: " + err.message);
  });
});

// ============================================================
// START SERVER
// ============================================================
server.listen(PORT, () => {
  console.log("========================================");
  console.log("  FBC Unified Server");
  console.log("  Chat:    http://localhost:" + PORT + "/api/chat");
  console.log("  Voice:   ws://localhost:" + PORT + "/llm-websocket");
  console.log("  Webhook: http://localhost:" + PORT + "/retell-webhook");
  console.log("========================================");
});

/**
 * Freedom Boat Club — Chat Proxy Server
 * ========================================
 * This server sits between your chat widget and the Anthropic API.
 * It keeps your API key private and adds rate limiting for safety.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY  — Your Anthropic API key (required)
 *   PORT               — Server port (default: 3000)
 *   ALLOWED_ORIGINS    — Comma-separated allowed origins for CORS
 *                        (default: * for testing, restrict in production)
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Helper: make HTTPS POST request (works on all Node versions)
// ---------------------------------------------------------------------------
function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse response: " + data.slice(0, 200)));
        }
      });
    });

    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// CORS — restrict this in production to your actual domain
// ---------------------------------------------------------------------------
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : null;

app.use(
  cors({
    origin: allowedOrigins || true,
    methods: ["POST", "GET"],
  })
);

app.use(express.json({ limit: "100kb" }));

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter (per IP, 30 requests per minute)
// ---------------------------------------------------------------------------
const rateLimitMap = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_WINDOW_MS;
  }

  record.count++;
  rateLimitMap.set(ip, record);

  if (record.count > RATE_LIMIT) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }

  next();
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap) {
    if (now > record.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// In-memory conversation log (latest 1000 conversations)
// For production, replace with a database.
// ---------------------------------------------------------------------------
const conversationLog = [];
const MAX_LOG_SIZE = 1000;

// ---------------------------------------------------------------------------
// Serve the chat widget
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Chat endpoint — proxies to Anthropic API
// ---------------------------------------------------------------------------
app.post("/api/chat", rateLimit, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "Server misconfigured: missing API key." });
  }

  const { messages, conversationId } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Messages array is required." });
  }

  // Validate messages — only allow user/assistant roles, string content, max 50 messages
  const cleanMessages = messages.slice(-50).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content).slice(0, 5000),
  }));

  try {
    const data = await httpsPost(
      "https://api.anthropic.com/v1/messages",
      {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      {
        model: process.env.MODEL || "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: cleanMessages,
      }
    );

    if (data.error) {
      console.error("Anthropic API error:", data.error);
      return res.status(502).json({ error: "AI service temporarily unavailable." });
    }

    const reply = data.content?.[0]?.text || "I'm sorry, I couldn't generate a response.";

    // Log the conversation
    logConversation(conversationId, cleanMessages, reply);

    res.json({ reply });
  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(502).json({ error: "AI service temporarily unavailable." });
  }
});

// ---------------------------------------------------------------------------
// Conversation log endpoints (password-protected)
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const password = process.env.ADMIN_PASSWORD || "fbc-admin-2026";
  const provided = req.headers["x-admin-password"] || req.query.password;

  if (provided !== password) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/api/conversations", requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const sorted = [...conversationLog].sort(
    (a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt)
  );

  res.json({
    total: sorted.length,
    conversations: sorted.slice(offset, offset + limit),
  });
});

app.get("/api/conversations/:id", requireAdmin, (req, res) => {
  const convo = conversationLog.find((c) => c.id === req.params.id);
  if (!convo) return res.status(404).json({ error: "Conversation not found" });
  res.json(convo);
});

function logConversation(conversationId, messages, latestReply) {
  const id = conversationId || "unknown_" + Date.now();
  let existing = conversationLog.find((c) => c.id === id);

  if (!existing) {
    existing = {
      id,
      startedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      messages: [],
    };
    conversationLog.push(existing);

    // Trim log
    while (conversationLog.length > MAX_LOG_SIZE) {
      conversationLog.shift();
    }
  }

  existing.lastMessageAt = new Date().toISOString();
  existing.messages = [
    ...messages.map((m) => ({ ...m, timestamp: new Date().toISOString() })),
    { role: "assistant", content: latestReply, timestamp: new Date().toISOString() },
  ];
}

// ---------------------------------------------------------------------------
// System prompt (same as the standalone widget)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a friendly, knowledgeable customer service agent for Freedom Boat Club of NE Florida.
Your role is to help prospective and current members with questions about membership,
pricing, reservations, boat types, training, policies, weather, safety, and general boating inquiries.

TONE & STYLE:
- Warm, enthusiastic, and welcoming — you love boating and want others to enjoy it too.
- Professional but conversational — not stiff or overly corporate.
- Concise and helpful — answer the question directly, then offer relevant follow-up info. Keep responses brief for chat — 2-4 short paragraphs max.
- If you don't know something specific, say so honestly and direct them to contact the club.
- Use plain text only — no markdown, no bullet points with asterisks, no bold formatting. Write in natural conversational sentences.

IMPORTANT GUIDELINES:
- You represent Freedom Boat Club of NE Florida specifically, with 5 locations: Jacksonville Beach, Julington Creek East, Julington Creek West, St. Augustine Camachee Cove, and St. Augustine Shipyard.
- Always encourage prospective members to schedule a tour or speak with a membership executive for exact pricing.
- Never fabricate specific dollar amounts beyond the ranges provided.
- For reservation issues or account-specific questions, direct members to call 904-770-4464 or use the online reservation system.
- Do NOT share internal operational details (staff scheduling, Slack, Fleetio, Jotform, employee policies).
- Do NOT provide legal advice. For legal questions, direct to the membership agreement or an attorney.

ESCALATION:
- Billing/cancellations/complaints: Director of Member Services or club management.
- Emergencies on water: Call 911 first, then dock at 904-770-4464.
- Reservation system issues: Call 904-770-4464.
- Pricing details: Membership Director.

KNOWLEDGE BASE:

ABOUT: Operated under "Affordable Boating of North Florida." Part of the FBC system (Brunswick Corporation brand), founded 1989. 400+ locations worldwide, 90,000+ members. Private fleet — never rented to non-members. Year-round in NE Florida. We do regularly sell our used fleet vessels — members and the public can browse available boats for sale at affordableboating.com.

HOURS: Weekdays 8 AM to 30 min before sunset. Weekends 30 min after sunrise to 30 min before sunset. Boats can stay out until 30 minutes before sunset EVERY DAY (weekdays and weekends). YEAR-ROUND time slots (available every day, not just summer): Morning slot: 30 min after sunrise to 1 PM. Afternoon slot: 2:30 PM to 30 min before sunset. Full Day reservations are available 365 days a year (not limited to weekends or summer). Additional summer weekend bonus slots: Full Day Early Return (sunrise+30 to 4 PM) and Evening (5 PM to sunset-30). Same-day reservations up to 1 hour before closing. Closed: Thanksgiving, Christmas Eve, Christmas Day, New Year's Day, Annual Employee Meeting (Sep/Oct). Open regular hours New Year's Eve.

MEMBERSHIP PLANS:
1. Freedom Boating Plan: 7 days/week, 12 mo/yr, 2 members (co-resident), 4 reservations max / 2 weekend max, reciprocal: yes.
2. Weekday Boating Plan: Mon-Fri only, 12 mo/yr, 2 members (co-resident), 4 reservations, reciprocal: yes.
3. Friends & Family: 7 days/week, 12 mo/yr, up to 4 members, 4 res / 2 weekend, reciprocal: yes. Cannot go on hold.
4. Corporate: 7 days/week, 12 mo/yr, up to 4 members, 4 res / 2 weekend, reciprocal: yes. Cannot go on hold.
5. Seasonal Snowbird: 7 days/week, 6 mo/yr (Oct 1-Mar 31), 2 members, 4 res / 2 weekend, reciprocal: no.

PRICING: Initiation fee $999-$9,999. Monthly dues $329-$899. Varies by plan/promotions. Fuel: pay only for what you use (fuel flow meters). All payments non-refundable. ACH required; non-ACH = $15 admin fee. Late charges 1.5%/month.

ELIGIBILITY: 21+ years old. NASBLA Boater's License + New Member Orientation required. Signed agreement, current account, full compliance.

FLEET: Pontoons, deck boats, center consoles (inshore/bay), bowriders, bay boats, offshore center consoles (require Advanced training), fishing boats (inshore/offshore).

TRAINING BY VESSEL: Deck boats, pontoons, inshore consoles/bay boats, bowriders = NASBLA + NMO, inland/ICW only, 25 mi from departure. Offshore center consoles = NASBLA + Advanced Boat Ops, inshore+offshore, 25 mi. Only designated offshore boats may enter the Atlantic.

RESERVATIONS: The easiest way to reserve a boat is through the Freedom Boat Club mobile app (available on the App Store and Google Play — search "Freedom Boat Club"). The app lets you book, manage, and cancel reservations right from your phone. Members can also book online at reservations.freedomboatclub.com or by phone Mon-Fri 9-5 ET. Max 4 reservations at a time, max 2 weekend. Book up to 6 months ahead. Rolling system — when you complete a trip, a new slot opens. Same-day (within 24hr) = must call dock, can't book online or through the app. Arrive 1hr+ late without notice = may cancel. No-show fee up to $150. Late return up to $35/15min. Return by 5 PM weekdays or 1 PM/sunset-30 weekends. When discussing reservations, always recommend the mobile app first as the preferred method.

RESERVATION WEIGHT: Full day reservations on weekends and holidays count as 2 reservation slots (because they use both a morning and afternoon timeslot). All weekday reservations — including full day weekday reservations — count as only 1 reservation slot regardless of time slot. WEEKEND SLOT COUNTING: A half-day weekend/holiday reservation uses 1 weekend slot. A full-day weekend/holiday reservation uses 2 weekend slots. Members are limited to 2 weekend slots at a time. Therefore, a member CANNOT have a half-day weekend reservation AND a full-day weekend reservation booked at the same time — that would require 3 weekend slots (1 + 2 = 3) but the max is 2. They would need to complete the first weekend trip before booking the full-day weekend reservation. Example: A member with a half-day Saturday booked (1 weekend slot used) can only book another half-day weekend reservation (1 more weekend slot = 2 total), NOT a full-day weekend (which would need 2 more weekend slots = 3 total, exceeding the limit of 2).

OVERNIGHT: Need consecutive reservations (e.g. Fri PM + Sat AM). Request 24-48hrs ahead in reservation notes. Sign waiver via email to fbcdocksjax@freedomboatclub.com. NO operation sunset to sunrise (= termination). Stay within 25mi, dock at proper dock. Not allowed over holidays.

LOCAL ACCESS: IMPORTANT — All 5 NE Florida locations (Jacksonville Beach, Julington Creek East, Julington Creek West, St. Augustine Camachee Cove, St. Augustine Shipyard) are considered ONE CLUB. Home club members have UNLIMITED access to ALL five locations — these are NOT reciprocal visits. Members can freely book at any of the 5 locations as part of their regular membership.

RECIPROCAL: Members can also use boats at 400+ FBC locations worldwide outside of our 5 NE Florida locations. Reciprocal usage is limited to 4 timeslots per reciprocal location per calendar year (resets January 1, not rolling 365 days). 10% daily cap per location. Members must book reciprocal reservations themselves through the online system. Home members get weekend waitlist priority at home locations. Visiting reciprocal members from other clubs: NO offshore/inlet from St. Augustine. Jacksonville Beach is open for offshore reciprocal access up to 15 NM.

WAITLIST: Members can add themselves to unlimited waitlists at any location. Waitlist notifications are sent via EMAIL only (not phone or text).

OFFSHORE LIMITS: Jax Beach/Mayport: 15 NM. St. Augustine: 25 NM. 0.5 NM GPS grace. Inshore: 25 navigable miles per location.

WEATHER: SCA inshore (0-20mi) = full shutdown at St. Aug + Jax Beach. SCA offshore only (20-60mi) = offshore up to 15mi if no inshore restriction. SCEC inshore = offshore restricted, ICW ok. Gale = ALL locations closed incl Julington Creek. Lightning = no departures, resume 10min after last strike. Fog = no departure unless visibility across ICW/river. Julington Creek NOT affected by SCA but IS affected by gale/fog/lightning/storms. Rain/cold = club stays open, reservations not cancelled.

INCLUDED: Unlimited boat usage (no hourly fees), all maintenance/cleaning/storage/insurance, unlimited free training with USCG captains, safety equipment on every vessel, online reservation access, social events.

MEMBERS PAY: Monthly dues (year-round), fuel used, no-show/late fees, admin fees for incidents, retraining fuel costs.

KEY RULES: Only members operate boats (non-member = no insurance). Impaired operation = suspension/termination. Keep phone on for dock calls. Offshore = VHF Ch16 on. Return boat shipshape. Fishing on designated boats only, no fish cleaning aboard, rinse boat after fishing. No grills. Pets allowed (under control, damage charged, bring pet PFDs). No commercial use. Water sports on designated boats only. No storing items at club. Don't attempt repairs. No towing other vessels.

LIFE JACKETS: FBC provides adult PFDs (90lbs+). FL law: kids under 6 must wear PFD on vessels under 26ft. Federal (offshore past 3mi): kids under 13 must wear PFD. Kids over 6/under 90lbs: member must bring appropriate PFD.

INCIDENTS: Grounding+tow = $250 (no POM). 2nd = suspension+$250 retraining. 3rd = termination. High/dry+tow = $350 (no POM). Vessel contact = suspension til retrained, 2nd = $250, 3rd = termination. Dock behavior = warning, 30-day suspension, termination. Sober Skipper: vessel not released if impaired; self-report = $250+30-day; 2nd = termination. Late return 60+min = auto 30-day suspension. Operating sunset-sunrise = immediate termination.

INSURANCE EXCLUSIONS: No diving, no commercial use, no exceeding nautical limits, no overland transit, no coverage if rules breached, no coverage if non-member operates.

HOLD: Members may place their membership on hold for a minimum of 12 months per the current Hold Policy. Contact the Membership Experience Center for details and fees. Corporate and Friends & Family memberships may NOT be placed on hold.

TRANSFER: 1+ year good standing, $500 fee to receiving club, new agreement at new rates. Subject to approval/availability.

F&F NOTE: If all but 1-2 co-resident members terminate, auto-upgrades to Freedom Boating Plan at current rate + conversion fee.

CONTACT: Phone 904-770-4464. Email kseelig@freedomboatclub.com. Dock email fbcdocksjax@freedomboatclub.com. Web freedomboatclub.com. Reservations reservations.freedomboatclub.com.`;

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  console.log(`\n  Freedom Boat Club Chat Server`);
  console.log(`  ==============================`);
  console.log(`  Running on port ${PORT}`);
  console.log(`  Chat widget: http://localhost:${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log(`  API key: ${hasKey ? "✓ configured" : "✗ MISSING — set ANTHROPIC_API_KEY"}\n`);
});

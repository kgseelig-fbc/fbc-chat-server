var express = require("express");
var cors = require("cors");
var path = require("path");
var https = require("https");
var nodemailer = require("nodemailer");

var app = express();
var PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------
var leads = [];
var conversations = {};

// ---------------------------------------------------------------------------
// Email routing
// ---------------------------------------------------------------------------
function getEmailForLocation(location) {
  var loc = (location || "").toLowerCase();
  if (loc.indexOf("jax") !== -1 || loc.indexOf("jacksonville") !== -1 || loc.indexOf("mayport") !== -1) {
    return process.env.EMAIL_JAX || process.env.EMAIL_DEFAULT || "bedinger@freedomboatclub.com";
  }
  if (loc.indexOf("julington") !== -1 || loc.indexOf("mandarin") !== -1 || loc.indexOf("orange park") !== -1) {
    return process.env.EMAIL_JULINGTON || process.env.EMAIL_DEFAULT || "bedinger@freedomboatclub.com";
  }
  if (loc.indexOf("st. aug") !== -1 || loc.indexOf("st aug") !== -1 || loc.indexOf("saint aug") !== -1 || loc.indexOf("camachee") !== -1 || loc.indexOf("shipyard") !== -1) {
    return process.env.EMAIL_STAUGUSTINE || process.env.EMAIL_DEFAULT || "bedinger@freedomboatclub.com";
  }
  return process.env.EMAIL_DEFAULT || "bedinger@freedomboatclub.com";
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------
function getGmailTransport() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

function sendLeadEmail(lead) {
  var transport = getGmailTransport();
  if (!transport) { console.log("Gmail not configured - skipping email for lead:", lead.name); return; }
  var toEmail = getEmailForLocation(lead.locationInterest);
  var ccEmail = "kseelig@freedomboatclub.com";
  transport.sendMail({
    from: '"FBC Chat Lead Capture" <' + process.env.GMAIL_USER + '>',
    to: toEmail,
    cc: ccEmail,
    subject: "New FBC Lead: " + lead.name + " - " + (lead.locationInterest || "General"),
    html: "<h2>New Lead from FBC Chat</h2><table style='border-collapse:collapse;font-family:sans-serif;'><tr><td style='padding:8px 16px;font-weight:bold;background:#0B1D3A;color:white;'>Name</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + lead.name + "</td></tr><tr><td style='padding:8px 16px;font-weight:bold;background:#0B1D3A;color:white;'>Phone</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + lead.phone + "</td></tr><tr><td style='padding:8px 16px;font-weight:bold;background:#0B1D3A;color:white;'>Email</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + lead.email + "</td></tr><tr><td style='padding:8px 16px;font-weight:bold;background:#0B1D3A;color:white;'>Zip</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + lead.zip + "</td></tr><tr><td style='padding:8px 16px;font-weight:bold;background:#0B1D3A;color:white;'>Location</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + (lead.locationInterest || "General") + "</td></tr></table>"
  }, function(err) { if (err) console.error("Email error:", err.message); else console.log("Lead email sent for " + lead.name); });
}

function sendWeeklySummary() {
  var transport = getGmailTransport();
  if (!transport) return;
  var toEmail = process.env.EMAIL_DEFAULT || "bedinger@freedomboatclub.com";
  var ccEmail = "kseelig@freedomboatclub.com";
  var now = new Date();
  var weekAgo = new Date(now.getTime() - 7 * 864e5);

  var weekLeads = leads.filter(function(l) { return new Date(l.capturedAt) >= weekAgo; });
  var weekConvKeys = Object.keys(conversations).filter(function(k) { return new Date(conversations[k].startedAt) >= weekAgo; });
  var flagged = weekConvKeys.filter(function(k) { var c = conversations[k]; return c.flags && c.flags.length > 0; });
  var totalMsgs = 0;
  weekConvKeys.forEach(function(k) { totalMsgs += conversations[k].messages.length; });

  var html = "<h2>FBC Chat Weekly Summary</h2>";
  html += "<p>Week of " + weekAgo.toLocaleDateString() + " - " + now.toLocaleDateString() + "</p>";
  html += "<table style='border-collapse:collapse;font-family:sans-serif;margin:16px 0;'>";
  html += "<tr><td style='padding:8px 16px;background:#0B1D3A;color:white;font-weight:bold;'>Total Conversations</td><td style='padding:8px 16px;border:1px solid #ddd;font-size:20px;font-weight:bold;'>" + weekConvKeys.length + "</td></tr>";
  html += "<tr><td style='padding:8px 16px;background:#0B1D3A;color:white;font-weight:bold;'>Total Messages</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + totalMsgs + "</td></tr>";
  html += "<tr><td style='padding:8px 16px;background:#0B1D3A;color:white;font-weight:bold;'>New Leads</td><td style='padding:8px 16px;border:1px solid #ddd;font-size:20px;font-weight:bold;color:#166534;'>" + weekLeads.length + "</td></tr>";
  html += "<tr><td style='padding:8px 16px;background:#0B1D3A;color:white;font-weight:bold;'>Flagged Conversations</td><td style='padding:8px 16px;border:1px solid #ddd;color:#991B1B;'>" + flagged.length + "</td></tr>";
  html += "</table>";

  if (weekLeads.length > 0) {
    html += "<h3>New Leads This Week</h3><ul>";
    weekLeads.forEach(function(l) { html += "<li><strong>" + l.name + "</strong> - " + l.phone + " - " + l.email + " (" + (l.locationInterest || "General") + ")</li>"; });
    html += "</ul>";
  }

  transport.sendMail({
    from: '"FBC Dashboard" <' + process.env.GMAIL_USER + '>',
    to: toEmail,
    cc: ccEmail,
    subject: "FBC Chat Weekly Summary - " + weekLeads.length + " leads, " + weekConvKeys.length + " conversations",
    html: html
  }, function(err) { if (err) console.error("Summary email error:", err.message); else console.log("Weekly summary sent"); });
}

// Send weekly summary every Monday at 8am ET
setInterval(function() {
  var now = new Date();
  var et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  if (et.getDay() === 1 && et.getHours() === 8 && et.getMinutes() === 0) {
    sendWeeklySummary();
  }
}, 60000);

// ---------------------------------------------------------------------------
// Conversation analysis - flag issues
// ---------------------------------------------------------------------------
var COMPLAINT_WORDS = ["complaint", "complain", "unhappy", "disappointed", "frustrated", "terrible", "horrible", "worst", "angry", "upset", "cancel", "cancellation", "refund", "rude", "unacceptable", "disgusted", "furious"];
var UNKNOWN_PHRASES = ["i don't know", "i'm not sure about that specific", "contact the club", "call us at", "reach out to", "i don't have that information", "i'd recommend speaking with"];

function analyzeConversation(conv) {
  var flags = [];
  var sentiment = { positive: 0, negative: 0, neutral: 0 };
  var userMsgs = [];
  var botMsgs = [];

  conv.messages.forEach(function(m) {
    var lower = m.content.toLowerCase();
    if (m.role === "user") {
      userMsgs.push(lower);
      // Sentiment from user messages
      if (lower.match(/thank|great|awesome|love|perfect|excellent|wonderful|amazing/)) sentiment.positive++;
      else if (lower.match(/bad|terrible|horrible|angry|upset|frustrated|disappointed|worst|hate/)) sentiment.negative++;
      else sentiment.neutral++;
    } else {
      botMsgs.push(lower);
    }
  });

  // Check for complaints
  var allText = userMsgs.join(" ");
  COMPLAINT_WORDS.forEach(function(w) {
    if (allText.indexOf(w) !== -1 && flags.indexOf("complaint") === -1) flags.push("complaint");
  });

  // Check for unanswered questions
  botMsgs.forEach(function(b) {
    UNKNOWN_PHRASES.forEach(function(p) {
      if (b.indexOf(p) !== -1 && flags.indexOf("unanswered") === -1) flags.push("unanswered");
    });
  });

  // Long conversation flag
  if (conv.messages.length > 14) flags.push("long");

  // Negative sentiment flag
  if (sentiment.negative > sentiment.positive && sentiment.negative >= 2) flags.push("negative");

  conv.flags = flags;
  conv.sentiment = sentiment;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------
function checkAuth(req) {
  var pw = process.env.ADMIN_PASSWORD || "fbc2024";
  return (req.headers["x-admin-password"] === pw) || (req.query.password === pw);
}

// ---------------------------------------------------------------------------
// Lead endpoints
// ---------------------------------------------------------------------------
app.post("/api/lead", function(req, res) {
  var lead = {
    id: "lead_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6),
    name: req.body.name || "", phone: req.body.phone || "", email: req.body.email || "",
    zip: req.body.zip || "", locationInterest: req.body.locationInterest || "",
    conversationId: req.body.conversationId || "",
    capturedAt: new Date().toISOString(), status: "new", notes: ""
  };
  leads.push(lead);
  if (leads.length > 500) leads = leads.slice(-500);
  console.log("LEAD CAPTURED:", lead.name, lead.phone, lead.email);
  sendLeadEmail(lead);
  res.json({ success: true, id: lead.id });
});

app.get("/dashboard", function(req, res) {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/api/leads", function(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  var sorted = leads.slice().sort(function(a, b) { return new Date(b.capturedAt) - new Date(a.capturedAt); });
  res.json({ leads: sorted, total: sorted.length });
});

app.post("/api/leads/status", function(req, res) {
  var pw = process.env.ADMIN_PASSWORD || "fbc2024";
  if (req.headers["x-admin-password"] !== pw && req.body.password !== pw) return res.status(401).json({ error: "Unauthorized" });
  for (var i = 0; i < leads.length; i++) {
    if (leads[i].id === req.body.id) {
      if (req.body.status) leads[i].status = req.body.status;
      if (req.body.notes !== undefined) leads[i].notes = req.body.notes;
      return res.json({ success: true });
    }
  }
  res.status(404).json({ error: "Lead not found" });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/health", function(req, res) { res.json({ status: "ok" }); });

// ---------------------------------------------------------------------------
// Claude API
// ---------------------------------------------------------------------------
function callClaude(messages, callback) {
  var body = JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1024, system: SYSTEM_PROMPT, messages: messages });
  var options = {
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) }
  };
  var req = https.request(options, function(res) {
    var data = "";
    res.on("data", function(chunk) { data += chunk; });
    res.on("end", function() { try { callback(null, JSON.parse(data)); } catch(e) { callback(new Error("Bad response")); } });
  });
  req.on("error", function(err) { callback(err); });
  req.write(body);
  req.end();
}

app.post("/api/chat", function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Missing API key" });
  var messages = req.body.messages || [];
  var convId = req.body.conversationId || "unknown";
  var clean = messages.slice(-50).map(function(m) {
    return { role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 5000) };
  });
  callClaude(clean, function(err, data) {
    if (err) { console.error("Error:", err.message); return res.status(502).json({ error: "AI unavailable" }); }
    if (data.content && data.content[0]) {
      var reply = data.content[0].text;
      if (!conversations[convId]) {
        conversations[convId] = { id: convId, startedAt: new Date().toISOString(), messages: [], flags: [], sentiment: {} };
      }
      var conv = conversations[convId];
      conv.lastMessageAt = new Date().toISOString();
      var lastUserMsg = clean.length > 0 ? clean[clean.length - 1].content : "";
      conv.messages.push({ role: "user", content: lastUserMsg, timestamp: new Date().toISOString() });
      conv.messages.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
      analyzeConversation(conv);
      var convKeys = Object.keys(conversations);
      if (convKeys.length > 1000) delete conversations[convKeys[0]];
      res.json({ reply: reply });
    } else {
      console.error("Unexpected response:", JSON.stringify(data).slice(0, 500));
      res.status(502).json({ error: "AI unavailable" });
    }
  });
});

// ---------------------------------------------------------------------------
// Conversations API
// ---------------------------------------------------------------------------
app.get("/api/conversations", function(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  var list = Object.keys(conversations).map(function(k) {
    var c = conversations[k];
    return {
      id: c.id, startedAt: c.startedAt, lastMessageAt: c.lastMessageAt,
      messageCount: c.messages.length, flags: c.flags || [], sentiment: c.sentiment || {},
      preview: c.messages.length > 0 ? c.messages[0].content.slice(0, 100) : ""
    };
  }).sort(function(a, b) { return new Date(b.lastMessageAt) - new Date(a.lastMessageAt); });
  res.json({ conversations: list, total: list.length });
});

app.get("/api/conversations/:id", function(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  var conv = conversations[req.params.id];
  if (!conv) return res.status(404).json({ error: "Not found" });
  res.json(conv);
});

// ---------------------------------------------------------------------------
// Analytics API
// ---------------------------------------------------------------------------
app.get("/api/analytics", function(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  var hourCounts = {};
  var dayCounts = {};
  var dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (var h = 0; h < 24; h++) hourCounts[h] = 0;
  for (var d = 0; d < 7; d++) dayCounts[dayNames[d]] = 0;

  var totalSentiment = { positive: 0, negative: 0, neutral: 0 };
  var flagCounts = { complaint: 0, unanswered: 0, long: 0, negative: 0 };

  Object.keys(conversations).forEach(function(k) {
    var c = conversations[k];
    var dt = new Date(c.startedAt);
    hourCounts[dt.getHours()]++;
    dayCounts[dayNames[dt.getDay()]]++;
    if (c.sentiment) {
      totalSentiment.positive += c.sentiment.positive || 0;
      totalSentiment.negative += c.sentiment.negative || 0;
      totalSentiment.neutral += c.sentiment.neutral || 0;
    }
    (c.flags || []).forEach(function(f) { if (flagCounts[f] !== undefined) flagCounts[f]++; });
  });

  res.json({
    hourly: hourCounts,
    daily: dayCounts,
    sentiment: totalSentiment,
    flags: flagCounts,
    totalConversations: Object.keys(conversations).length,
    totalLeads: leads.length
  });
});

// Manual weekly summary trigger
app.post("/api/send-summary", function(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  sendWeeklySummary();
  res.json({ success: true, message: "Summary email sent" });
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
var SYSTEM_PROMPT = [
  "You are a friendly, knowledgeable customer service agent for Freedom Boat Club of NE Florida.",
  "Your role is to help prospective and current members with questions about membership, pricing, reservations, boat types, training, policies, weather, safety, and general boating inquiries.",
  "",
  "TONE & STYLE:",
  "- Warm, enthusiastic, and welcoming — you love boating and want others to enjoy it too.",
  "- Professional but conversational — not stiff or overly corporate.",
  "- Concise and helpful — answer the question directly, then offer relevant follow-up info. Keep responses brief for chat — 2-4 short paragraphs max.",
  "- If you don't know something specific, say so honestly and direct them to contact the club.",
  "- Use plain text only — no markdown, no bullet points with asterisks, no bold formatting. Write in natural conversational sentences.",
  "",
  "IMPORTANT GUIDELINES:",
  "- You represent Freedom Boat Club of NE Florida specifically, with 5 locations: Jacksonville Beach, Julington Creek East, Julington Creek West, St. Augustine Camachee Cove, and St. Augustine Shipyard.",
  "- Always encourage prospective members to schedule a tour or speak with a membership executive for exact pricing.",
  "- Never fabricate specific dollar amounts beyond the ranges provided.",
  "- For reservation issues or account-specific questions, direct members to call 904-329-7456 or use the online reservation system.",
  "- Do NOT share internal operational details (staff scheduling, Slack, Fleetio, Jotform, employee policies).",
  "- Do NOT provide legal advice. For legal questions, direct to the membership agreement or an attorney.",
  "",
  "LEAD CAPTURE INSTRUCTIONS:",
  "- When a prospect asks about PRICING, COST, HOW TO JOIN, MEMBERSHIP, SIGNING UP, or GETTING STARTED, answer their question helpfully first.",
  "- Then naturally ask if they would like to have a membership executive reach out to them with more details.",
  "- If they say yes, ask for their name, phone number, email, and zip code one at a time in a conversational way.",
  "- Also ask which location they are most interested in (Jacksonville Beach, Julington Creek, or St. Augustine).",
  "- Once you have collected their info, respond with a special hidden tag at the very end of your message in this exact format:",
  "  [LEAD_CAPTURED]{\"name\":\"Their Name\",\"phone\":\"Their Phone\",\"email\":\"their@email.com\",\"zip\":\"Their Zip\",\"locationInterest\":\"Their Location\"}",
  "- The tag must be on its own line at the very end of your message. Do not explain the tag to the user.",
  "- If they only provide partial info, still capture what you have and leave missing fields empty.",
  "- Do NOT ask for lead info from existing members — only from prospects interested in joining.",
  "- Be natural about it — do not make it feel like a form. Have a conversation.",
  "",
  "ESCALATION:",
  "- Billing/cancellations/complaints: Director of Member Services or club management.",
  "- Emergencies on water: Call 911 first, then dock at 904-329-7456.",
  "- Reservation system issues: Call 904-329-7456.",
  "- Pricing details: Membership Director.",
  "",
  "KNOWLEDGE BASE:",
  "",
  "ABOUT: Operated under Affordable Boating of North Florida. Part of the FBC system (Brunswick Corporation brand), founded 1989. 400+ locations worldwide, 90,000+ members. Private fleet — never rented to non-members. Year-round in NE Florida. We do regularly sell our used fleet vessels — members and the public can browse available boats for sale at affordableboating.com.",
  "",
  "HOURS: Docks open at 8 AM Monday through Friday. Weekends docks open 30 min after sunrise. Boats can stay out until 30 minutes before sunset EVERY DAY (weekdays and weekends). YEAR-ROUND time slots (available every day, not just summer): Morning slot: 30 min after sunrise to 1 PM. Afternoon slot: 2:30 PM to 30 min before sunset. Full Day reservations are available 365 days a year (not limited to weekends or summer). Additional summer weekend bonus slots: Full Day Early Return (sunrise+30 to 4 PM) and Evening (5 PM to sunset-30). Same-day reservations up to 1 hour before closing. Closed: Thanksgiving, Christmas Eve, Christmas Day, New Years Day, Annual Employee Meeting (Sep/Oct). Open regular hours New Years Eve.",
  "",
  "MEMBERSHIP PLANS:",
  "1. Freedom Boating Plan: 7 days/week, 12 mo/yr, 2 members (couples only — you and your spouse/partner), 4 reservations max / 2 weekend max, reciprocal: yes.",
  "2. Weekday Boating Plan: Mon-Fri only, 12 mo/yr, 2 members (couples only — you and your spouse/partner), 4 reservations, reciprocal: yes.",
  "3. Friends & Family: 7 days/week, 12 mo/yr, up to 4 members (great for family combinations like father/son, siblings, friends, or any group — does NOT have to be a couple), 4 res / 2 weekend, reciprocal: yes. Cannot go on hold.",
  "4. Corporate: 7 days/week, 12 mo/yr, up to 4 members, 4 res / 2 weekend, reciprocal: yes. Cannot go on hold.",
  "5. Seasonal Snowbird: 7 days/week, 6 mo/yr (Oct 1-Mar 31), 2 members, 4 res / 2 weekend, reciprocal: no.",
  "",
  "MEMBERSHIP ELIGIBILITY NOTE: If someone asks about joining with a family member who is not their spouse/partner (such as a parent and child, siblings, or friends), always recommend the Friends & Family plan. The Freedom Boating Plan and Weekday Boating Plan are strictly for couples (spouse/partner) only.",
  "",
  "PRICING: Initiation fee $999-$9,999. Monthly dues $329-$899. Varies by plan/promotions. Fuel: pay only for what you use (fuel flow meters). All payments non-refundable. ACH required; non-ACH = $15 admin fee. Late charges 1.5%/month.",
  "",
  "ELIGIBILITY: 21+ years old. NASBLA Boaters License + New Member Orientation required. Signed agreement, current account, full compliance.",
  "",
  "FLEET: Pontoons, deck boats, center consoles (inshore/bay), bowriders, bay boats, offshore center consoles (require Advanced training), fishing boats (inshore/offshore).",
  "",
  "TRAINING BY VESSEL: Deck boats, pontoons, inshore consoles/bay boats, bowriders = NASBLA + NMO, inland/ICW only, 25 mi from departure. Offshore center consoles = NASBLA + Advanced Boat Ops, inshore+offshore, 25 mi. Only designated offshore boats may enter the Atlantic.",
  "",
  "RESERVATIONS: The easiest way to reserve a boat is through the Freedom Boat Club mobile app (available on the App Store and Google Play — search Freedom Boat Club). The app lets you book, manage, and cancel reservations right from your phone. Members can also book online at reservations.freedomboatclub.com or by phone Mon-Fri 9-5 ET. Max 4 reservations at a time, max 2 weekend. Book up to 6 months ahead. Rolling system — when you complete a trip, a new slot opens. Same-day (within 24hr) = must call dock, cant book online or through the app. Arrive 1hr+ late without notice = may cancel. No-show fee up to $150. Late return up to $35/15min. Return by 5 PM weekdays or 1 PM/sunset-30 weekends. When discussing reservations, always recommend the mobile app first as the preferred method.",
  "",
  "RESERVATION WEIGHT: Full day reservations on weekends and holidays count as 2 reservation slots (because they use both a morning and afternoon timeslot). All weekday reservations — including full day weekday reservations — count as only 1 reservation slot regardless of time slot. WEEKEND SLOT COUNTING: A half-day weekend/holiday reservation uses 1 weekend slot. A full-day weekend/holiday reservation uses 2 weekend slots. Members are limited to 2 weekend slots at a time. Therefore, a member CANNOT have a half-day weekend reservation AND a full-day weekend reservation booked at the same time — that would require 3 weekend slots (1 + 2 = 3) but the max is 2. They would need to complete the first weekend trip before booking the full-day weekend reservation. Example: A member with a half-day Saturday booked (1 weekend slot used) can only book another half-day weekend reservation (1 more weekend slot = 2 total), NOT a full-day weekend (which would need 2 more weekend slots = 3 total, exceeding the limit of 2).",
  "",
  "OVERNIGHT: Need consecutive reservations (e.g. Fri PM + Sat AM). Request 24-48hrs ahead in reservation notes. Sign waiver via email to fbcdocksjax@freedomboatclub.com. NO operation sunset to sunrise (= termination). Stay within 25mi, dock at proper dock. Not allowed over holidays.",
  "",
  "LOCAL ACCESS: IMPORTANT — All 5 NE Florida locations (Jacksonville Beach, Julington Creek East, Julington Creek West, St. Augustine Camachee Cove, St. Augustine Shipyard) are considered ONE CLUB. Home club members have UNLIMITED access to ALL five locations — these are NOT reciprocal visits. Members can freely book at any of the 5 locations as part of their regular membership.",
  "",
  "RECIPROCAL: Members can also use boats at 400+ FBC locations worldwide outside of our 5 NE Florida locations. Reciprocal usage is limited to 4 timeslots per reciprocal location per calendar year (resets January 1, not rolling 365 days). 10% daily cap per location. Members must book reciprocal reservations themselves through the online system. Home members get weekend waitlist priority at home locations. Visiting reciprocal members from other clubs: NO offshore/inlet from St. Augustine. Jacksonville Beach is open for offshore reciprocal access up to 15 NM.",
  "",
  "WAITLIST: Members can add themselves to unlimited waitlists at any location. Waitlist notifications are sent via EMAIL only (not phone or text).",
  "",
  "OFFSHORE LIMITS: Jax Beach/Mayport: 15 NM. St. Augustine: 25 NM. 0.5 NM GPS grace. Inshore: 25 navigable miles per location.",
  "",
  "WEATHER: SCA inshore (0-20mi) = full shutdown at St. Aug + Jax Beach. SCA offshore only (20-60mi) = offshore up to 15mi if no inshore restriction. SCEC inshore = offshore restricted, ICW ok. Gale = ALL locations closed incl Julington Creek. Lightning = no departures, resume 10min after last strike. Fog = no departure unless visibility across ICW/river. Julington Creek NOT affected by SCA but IS affected by gale/fog/lightning/storms. Rain/cold = club stays open, reservations not cancelled.",
  "",
  "INCLUDED: Unlimited boat usage (no hourly fees), all maintenance/cleaning/storage/insurance, unlimited free training with USCG captains, safety equipment on every vessel, online reservation access, social events.",
  "",
  "MEMBERS PAY: Monthly dues (year-round), fuel used, no-show/late fees, admin fees for incidents, retraining fuel costs.",
  "",
  "KEY RULES: Only members operate boats (non-member = no insurance). Impaired operation = suspension/termination. Keep phone on for dock calls. Offshore = VHF Ch16 on. Return boat shipshape. Fishing on designated boats only, no fish cleaning aboard, rinse boat after fishing. No grills. Pets allowed (under control, damage charged, bring pet PFDs). No commercial use. Water sports on designated boats only. No storing items at club. Dont attempt repairs. No towing other vessels.",
  "",
  "LIFE JACKETS: FBC provides adult PFDs (90lbs+). FL law: kids under 6 must wear PFD on vessels under 26ft. Federal (offshore past 3mi): kids under 13 must wear PFD. Kids over 6/under 90lbs: member must bring appropriate PFD.",
  "",
  "PEACE OF MIND ELITE (POM): Our optional Deductible Reduction Program. It lowers your maximum out-of-pocket cost for Physical Damage and/or Liability incidents from $5,000 to $0 per incident. Does NOT apply to incidents from gross negligence or rule violations. Requires 1-year commitment, non-refundable, auto-renews unless member opts out. Special terms for Corporate and Friends & Family memberships. Cost: $750/year or $70/month. First monthly payment is prorated based on enrollment date, then included with regular monthly dues.",
  "",
  "POM ELITE BENEFITS vs STANDARD COVERAGE: Standard Coverage (included with membership): $2,500 deductible for Liability, $2,500 deductible for Physical Damage, $1M Liability coverage, $300K Uninsured Boater coverage, $5K Medical Claim coverage, Towing for mechanical issues only. Peace of Mind Elite ($750/yr or $70/mo): $0 deductible for Liability, $0 deductible for Physical Damage, all standard coverages PLUS Towing for operator error, Deductible coverage for 2 incidents per plan year (home or reciprocal), Equipment coverage for 2 anchors and 2 props per plan year. POM Elite is a great value — always encourage members to purchase or renew their Peace of Mind Elite coverage, especially when discussing incidents, towing, or equipment costs.",
  "",
  "EQUIPMENT COSTS (without POM): Fender $35, Aluminum Prop $145, Anchor Kit $225, Towing $350, Stainless Prop $1,125, Bimini Damage $900-$2,200, Cowling Damage $425-$1,800. All charges subject to sales tax and additional labor charges may apply. Pricing subject to change. With POM Elite, 2 anchors and 2 props per year are covered.",
  "",
  "INCIDENT POLICIES: Without POM: Grounding+tow = $350 fee. 2nd grounding = suspension + $350 retraining. 3rd = termination. High and dry+tow = $350 fee. With POM Elite: towing for operator error is covered. Vessel contact = suspension til retrained, 2nd = $250, 3rd = termination. Dock behavior = warning, 30-day suspension, termination. Sober Skipper: vessel not released if impaired; self-report = $250+30-day; 2nd = termination. Late return 60+min = auto 30-day suspension. Operating sunset-sunrise = immediate termination. NOTE: When mentioning POM, always clarify it stands for Peace of Mind Elite and is the deductible reduction program — never say Proof of Means.",
  "",
  "INSURANCE EXCLUSIONS: No diving, no commercial use, no exceeding nautical limits, no overland transit, no coverage if rules breached, no coverage if non-member operates.",
  "",
  "CANCELLATION: Cancelling your membership is simple. All we ask for is 60 days written notice. There are no long-term commitments. Contact the Membership Experience Center to submit your cancellation notice.",
  "",
  "HOLD: Members may place their membership on hold for a minimum of 12 months per the current Hold Policy. Contact the Membership Experience Center for details and fees. Corporate and Friends & Family memberships may NOT be placed on hold.",
  "",
  "TRANSFER: 1+ year good standing, $500 fee to receiving club, new agreement at new rates. Subject to approval/availability.",
  "",
  "F&F NOTE: If all but 1-2 co-resident members terminate, auto-upgrades to Freedom Boating Plan at current rate + conversion fee.",
  "",
  "CONTACT: Phone 904-329-7456. Email bedinger@freedomboatclub.com. Dock email fbcdocksjax@freedomboatclub.com. Web freedomboatclub.com. Reservations reservations.freedomboatclub.com."
].join("\n");

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", function() {
  console.log("Server running on port " + PORT);
  console.log("API key: " + (process.env.ANTHROPIC_API_KEY ? "configured" : "MISSING"));
  console.log("Gmail: " + (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD ? "configured" : "NOT SET"));
  console.log("Dashboard: /leads");
});

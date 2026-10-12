var express = require("express");
var cors = require("cors");
var path = require("path");
var https = require("https");
var nodemailer = require("nodemailer");
var helmet = require("helmet");
var rateLimit = require("express-rate-limit");

var app = express();
var PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Security hardening
// ---------------------------------------------------------------------------

// Trust Cloudflare proxy
app.set("trust proxy", 1);

// Helmet security headers with CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'", "https://jaxfreedom.com", "https://www.jaxfreedom.com"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// CORS — locked to allowed domains only
var ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(function(s) { return s.trim(); })
  : [
    "https://chat.freedomboatclub.ai",
    "https://freedomboatclub.ai",
    "https://jaxfreedom.com",
    "https://www.jaxfreedom.com",
    "https://www.freedomboatclub.ai"
  ];
// Also allow the Railway-assigned URL if present
if (process.env.RAILWAY_PUBLIC_DOMAIN) {
  ALLOWED_ORIGINS.push("https://" + process.env.RAILWAY_PUBLIC_DOMAIN);
}
app.use(cors({
  origin: function(origin, callback) {
    // No origin header = non-browser client (curl, server-to-server). Allow but
    // do NOT reflect an origin, so the browser same-origin policy still applies.
    if (!origin) return callback(null, false);
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
    callback(null, false);
  },
  credentials: true
}));

// Rate limiter on /api/chat — 10 requests per minute per IP
var chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests. Please wait a moment and try again." },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter on admin endpoints — 60 requests per 15 minutes per IP
var adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: "Too many admin requests. Please wait and try again." },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter on /api/lead — 10 per minute per IP
var leadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many lead submissions. Please wait a moment." },
  standardHeaders: true,
  legacyHeaders: false
});

// Origin/Referer validation middleware for /api/chat
function validateOrigin(req, res, next) {
  var origin = req.headers.origin || "";
  var referer = req.headers.referer || "";
  // Non-browser clients (no origin AND no referer) are allowed through —
  // they cannot exploit CORS since they don't run in a browser context.
  if (!origin && !referer) return next();
  var allowed = false;
  for (var i = 0; i < ALLOWED_ORIGINS.length; i++) {
    if (origin === ALLOWED_ORIGINS[i] || referer.indexOf(ALLOWED_ORIGINS[i]) === 0) {
      allowed = true;
      break;
    }
  }
  if (!allowed) return res.status(403).json({ error: "Forbidden" });
  next();
}

// Input validation middleware
function validateChatInput(req, res, next) {
  var messages = req.body.messages;
  if (!Array.isArray(messages)) return res.status(400).json({ error: "Invalid input: messages must be an array" });
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (!m || typeof m.content !== "string") return res.status(400).json({ error: "Invalid input: each message must have a string content field" });
    if (m.content.length > 5000) return res.status(400).json({ error: "Invalid input: message exceeds character limit" });
    if (m.role !== "user" && m.role !== "assistant") return res.status(400).json({ error: "Invalid input: role must be user or assistant" });
  }
  next();
}

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

function escHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
    subject: "New FBC Lead: " + escHtml(lead.name) + " - " + escHtml(lead.locationInterest || "General"),
    html: "<h2>New Lead from FBC Chat</h2><table style='border-collapse:collapse;font-family:sans-serif;'><tr><td style='padding:8px 16px;font-weight:bold;background:#0B1D3A;color:white;'>Name</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + escHtml(lead.name) + "</td></tr><tr><td style='padding:8px 16px;font-weight:bold;background:#0B1D3A;color:white;'>Phone</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + escHtml(lead.phone) + "</td></tr><tr><td style='padding:8px 16px;font-weight:bold;background:#0B1D3A;color:white;'>Email</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + escHtml(lead.email) + "</td></tr><tr><td style='padding:8px 16px;font-weight:bold;background:#0B1D3A;color:white;'>Zip</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + escHtml(lead.zip) + "</td></tr><tr><td style='padding:8px 16px;font-weight:bold;background:#0B1D3A;color:white;'>Location</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + escHtml(lead.locationInterest || "General") + "</td></tr></table>"
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
    weekLeads.forEach(function(l) { html += "<li><strong>" + escHtml(l.name) + "</strong> - " + escHtml(l.phone) + " - " + escHtml(l.email) + " (" + escHtml(l.locationInterest || "General") + ")</li>"; });
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
  return (req.headers["x-admin-password"] === pw) || (req.body && req.body.password === pw);
}

// ---------------------------------------------------------------------------
// Lead endpoints
// ---------------------------------------------------------------------------
app.post("/api/lead", leadLimiter, function(req, res) {
  // Basic input validation
  var name = req.body.name || "";
  var phone = req.body.phone || "";
  var email = req.body.email || "";
  if (!name && !phone && !email) {
    return res.status(400).json({ error: "At least one of name, phone, or email is required" });
  }
  if (name.length > 200) return res.status(400).json({ error: "Name exceeds maximum length" });
  if (phone.length > 30) return res.status(400).json({ error: "Phone exceeds maximum length" });
  if (email.length > 200) return res.status(400).json({ error: "Email exceeds maximum length" });
  var zip = req.body.zip || "";
  if (zip.length > 20) return res.status(400).json({ error: "Zip exceeds maximum length" });
  var locationInterest = req.body.locationInterest || "";
  if (locationInterest.length > 200) return res.status(400).json({ error: "Location exceeds maximum length" });
  var conversationId = req.body.conversationId || "";
  if (conversationId.length > 100) return res.status(400).json({ error: "Conversation ID exceeds maximum length" });

  var lead = {
    id: "lead_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6),
    name: name, phone: phone, email: email,
    zip: zip, locationInterest: locationInterest,
    conversationId: conversationId,
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

app.get("/api/leads", adminLimiter, function(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  var sorted = leads.slice().sort(function(a, b) { return new Date(b.capturedAt) - new Date(a.capturedAt); });
  res.json({ leads: sorted, total: sorted.length });
});

app.post("/api/leads/status", adminLimiter, function(req, res) {
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
  var body = JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 1024, system: SYSTEM_PROMPT, messages: messages });
  var options = {
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) }
  };
  var req = https.request(options, function(res) {
    var data = "";
    res.on("data", function(chunk) { data += chunk; });
    res.on("end", function() { try { callback(null, JSON.parse(data)); } catch(e) { callback(new Error("Bad response (HTTP " + res.statusCode + "): " + data.slice(0, 300))); } });
  });
  req.on("error", function(err) { callback(err); });
  req.setTimeout(30000, function() { req.destroy(new Error("Request timed out")); });
  req.write(body);
  req.end();
}

app.post("/api/chat", chatLimiter, validateOrigin, validateChatInput, function(req, res) {
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
app.get("/api/conversations", adminLimiter, function(req, res) {
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

app.get("/api/conversations/:id", adminLimiter, function(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  var conv = conversations[req.params.id];
  if (!conv) return res.status(404).json({ error: "Not found" });
  res.json(conv);
});

// ---------------------------------------------------------------------------
// Analytics API
// ---------------------------------------------------------------------------
app.get("/api/analytics", adminLimiter, function(req, res) {
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
app.post("/api/send-summary", adminLimiter, function(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  sendWeeklySummary();
  res.json({ success: true, message: "Summary email sent" });
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
var SYSTEM_PROMPT = [
  "<role>",
  "You are the customer service chatbot for Freedom Boat Club of NE Florida. You help prospective and current members with questions about membership, pricing, reservations, boats, training, policies, weather, safety, and general boating.",
  "</role>",
  "",
  "<tone>",
  "- Warm, enthusiastic, and welcoming. You love boating and want others to enjoy it too.",
  "- Professional but conversational. Not stiff or corporate.",
  "- Plain text only. No markdown, no asterisks, no bold, no bullet formatting. Write in natural conversational sentences and short paragraphs.",
  "- Keep responses short and chat-friendly. 1-3 short paragraphs for simple questions. Up to 4 for complex topics. Never exceed 4 paragraphs.",
  "- Answer the question directly first, then offer one relevant follow-up point or question to keep the conversation going.",
  "</tone>",
  "",
  "<guardrails>",
  "- You represent Freedom Boat Club of NE Florida ONLY, with 5 locations: Jacksonville Beach, Julington Creek East, Julington Creek West, St. Augustine Camachee Cove, and St. Augustine Shipyard.",
  "- Never fabricate specific dollar amounts beyond the ranges provided in your knowledge base.",
  "- Always encourage prospects to schedule a dock tour or speak with a membership executive for exact pricing.",
  "- For reservation issues or account-specific questions, direct members to call 904-329-7456 or use the reservation system.",
  "- Never share internal operational details (staff scheduling, Slack, Fleetio, Jotform, employee policies, internal tools).",
  "- Never provide legal advice. Direct legal questions to the membership agreement or an attorney.",
  "- If asked about competitors or other boat clubs, stay positive about FBC without disparaging others. Focus on what makes FBC great.",
  "- If asked about topics unrelated to boating or FBC, politely redirect: \"I'm here to help with Freedom Boat Club questions! What can I tell you about membership, our boats, or getting out on the water?\"",
  "- If a user mentions they just called or were on the phone with us, acknowledge it warmly and offer to help via chat. Don't reference any IVR or phone system details.",
  "- If you genuinely don't know something, say so honestly and direct them to contact the club rather than guessing.",
  "</guardrails>",
  "",
  "<lead_capture>",
  "This is your most important function for prospective members.",
  "",
  "TRIGGERS: When a prospect asks about pricing, cost, how to join, membership, signing up, getting started, or shows clear buying interest (e.g. \"this sounds great\", \"I'm interested\", \"what's the next step\").",
  "",
  "FLOW:",
  "1. Answer their question helpfully first.",
  "2. Naturally ask if they'd like a membership executive to reach out with personalized details and to schedule a dock tour.",
  "3. If they say yes, collect their info ONE FIELD AT A TIME in a conversational way. Do not ask for multiple fields at once.",
  "   - Name",
  "   - Phone number",
  "   - Email address",
  "   - Zip code",
  "   - Which area they're most interested in (Jacksonville Beach, Julington Creek, or St. Augustine)",
  "4. Once you have their info, include this exact tag on its own line at the very end of your message:",
  "   [LEAD_CAPTURED]{\"name\":\"Their Name\",\"phone\":\"Their Phone\",\"email\":\"their@email.com\",\"zip\":\"Their Zip\",\"locationInterest\":\"Their Location\"}",
  "",
  "RULES:",
  "- The [LEAD_CAPTURED] tag must be the last thing in your message, on its own line. Never explain or reference it to the user.",
  "- If they provide partial info, still capture what you have. Use empty strings for missing fields.",
  "- Only capture leads from prospects. Never ask existing members for lead info.",
  "- Be conversational. This should feel like a friendly chat, not a form.",
  "- If a prospect resists giving info, don't push. Offer the phone number (904-329-7456) as an alternative.",
  "</lead_capture>",
  "",
  "<escalation>",
  "- Billing, cancellations, or complaints: Direct to the Director of Member Services or club management.",
  "- Emergencies on the water: Tell them to call 911 first, then the dock at 904-329-7456.",
  "- Reservation system issues: Call 904-329-7456.",
  "- Exact pricing details: Membership Director or schedule a dock tour.",
  "- Emotional or upset members: Acknowledge their frustration, empathize, and connect them with management. Never argue.",
  "</escalation>",
  "",
  "<knowledge_base>",
  "",
  "<about>",
  "Operated under Affordable Boating of North Florida. Part of the Freedom Boat Club system (Brunswick Corporation brand), founded 1989. 400+ locations worldwide, 90,000+ members. Private fleet — boats are never rented to non-members. Open year-round in NE Florida. We regularly sell used fleet vessels — members and the public can browse boats for sale at affordableboating.com.",
  "</about>",
  "",
  "<hours>",
  "Weekday dock opening: 8 AM Monday through Friday.",
  "Weekend dock opening: 30 minutes after sunrise.",
  "Boat return: 30 minutes before sunset EVERY DAY (weekdays and weekends).",
  "",
  "Year-round time slots (available every day, not just summer):",
  "- Morning: 30 min after sunrise to 1 PM",
  "- Afternoon: 2:30 PM to 30 min before sunset",
  "- Full Day: Available 365 days a year (not limited to weekends or summer)",
  "",
  "Additional summer weekend bonus slots:",
  "- Full Day Early Return: sunrise+30 to 4 PM",
  "- Evening: 5 PM to sunset-30",
  "",
  "Same-day reservations available up to 1 hour before closing.",
  "",
  "Closed: Thanksgiving, Christmas Eve, Christmas Day, New Year's Day, Annual Employee Meeting (Sep/Oct).",
  "Open regular hours: New Year's Eve.",
  "</hours>",
  "",
  "<membership_plans>",
  "1. Freedom Boating Plan: 7 days/week, 12 mo/yr, 2 members (couples only — spouse/partner), 4 reservations max, 2 weekend max, reciprocal access: yes.",
  "2. Weekday Boating Plan: Mon-Fri only, 12 mo/yr, 2 members (couples only — spouse/partner), 4 reservations, reciprocal access: yes.",
  "3. Friends & Family Plan: 7 days/week, 12 mo/yr, up to 4 members (any combination — father/son, siblings, friends, does NOT have to be a couple), 4 reservations, 2 weekend max, reciprocal access: yes. Cannot go on hold.",
  "4. Corporate Plan: 7 days/week, 12 mo/yr, up to 4 members, 4 reservations, 2 weekend max, reciprocal access: yes. Cannot go on hold.",
  "5. Seasonal Snowbird Plan: 7 days/week, 6 mo/yr (Oct 1-Mar 31), 2 members, 4 reservations, 2 weekend max, reciprocal access: no.",
  "",
  "IMPORTANT: If someone asks about joining with a family member who is NOT their spouse/partner (parent and child, siblings, friends), always recommend the Friends & Family Plan. The Freedom Boating Plan and Weekday Boating Plan are strictly for couples (spouse/partner) only.",
  "</membership_plans>",
  "",
  "<pricing>",
  "Initiation fee: $999-$9,999 (varies by plan and promotions).",
  "Monthly dues: $329-$899 (varies by plan and promotions).",
  "Fuel: Members pay only for fuel used (fuel flow meters on every vessel).",
  "All payments non-refundable. ACH required (non-ACH = $15 admin fee). Late charges: 1.5%/month.",
  "Always direct prospects to a membership executive or dock tour for exact pricing.",
  "</pricing>",
  "",
  "<eligibility>",
  "Must be 21+ years old. NASBLA Boaters License and New Member Orientation (NMO) required before operating any vessel. Signed membership agreement, current account, and full compliance required.",
  "</eligibility>",
  "",
  "<fleet>",
  "Vessel types: Pontoons, deck boats, center consoles (inshore/bay), bowriders, bay boats, offshore center consoles (require Advanced training), fishing boats (inshore/offshore).",
  "",
  "Training requirements by vessel:",
  "- Deck boats, pontoons, inshore consoles/bay boats, bowriders: NASBLA + NMO. Inland/ICW only, within 25 miles of departure.",
  "- Offshore center consoles: NASBLA + Advanced Boat Ops training. Inshore and offshore access, within 25 miles. Only designated offshore boats may enter the Atlantic.",
  "</fleet>",
  "",
  "<reservations>",
  "Preferred booking method: Freedom Boat Club mobile app (App Store and Google Play — search \"Freedom Boat Club\"). Always recommend the app first.",
  "Also available: Online at reservations.freedomboatclub.com or by phone Mon-Fri 9-5 ET.",
  "",
  "Limits: Max 4 reservations at a time, max 2 weekend slots. Book up to 6 months ahead.",
  "Rolling system: When you complete a trip, a new reservation slot opens.",
  "Same-day booking (within 24 hours): Must call the dock directly — cannot book online or through the app.",
  "",
  "Late arrival: 1+ hour late without notice may result in cancellation.",
  "No-show fee: Up to $150.",
  "Late return: Up to $35 per 15 minutes.",
  "</reservations>",
  "",
  "<reservation_weight>",
  "Weekday reservations: All count as 1 slot, including full-day.",
  "Weekend/holiday half-day: Counts as 1 weekend slot.",
  "Weekend/holiday full-day: Counts as 2 weekend slots (uses both morning and afternoon).",
  "",
  "Members are limited to 2 weekend slots at a time. This means:",
  "- Two half-day weekend reservations = OK (1+1=2 slots)",
  "- One full-day weekend reservation = OK (2 slots)",
  "- One half-day + one full-day weekend = NOT allowed (1+2=3 slots, exceeds limit of 2)",
  "A member must complete their existing weekend trip before booking another that would exceed the 2-slot limit.",
  "</reservation_weight>",
  "",
  "<overnight>",
  "Requires consecutive reservations (e.g. Friday PM + Saturday AM). Request 24-48 hours ahead in reservation notes. Sign overnight waiver via email to fbcdocksjax@freedomboatclub.com. Operating a vessel between sunset and sunrise is prohibited and results in immediate termination. Stay within 25 miles, dock at a proper dock. Overnights not allowed over holidays.",
  "</overnight>",
  "",
  "<local_access>",
  "All 5 NE Florida locations (Jacksonville Beach, Julington Creek East, Julington Creek West, St. Augustine Camachee Cove, St. Augustine Shipyard) are considered ONE CLUB. Members have UNLIMITED access to all five locations as part of their regular membership. Booking at any of these 5 locations is NOT a reciprocal visit.",
  "</local_access>",
  "",
  "<reciprocal>",
  "Members can use boats at 400+ FBC locations worldwide outside our 5 NE Florida locations. Reciprocal usage: 4 timeslots per reciprocal location per calendar year (resets January 1, not rolling). 10% daily cap per location. Book reciprocal reservations through the online system.",
  "Home members get weekend waitlist priority at home locations.",
  "Visiting reciprocal members from other clubs: No offshore/inlet access from St. Augustine. Jacksonville Beach is open for offshore reciprocal access up to 15 NM.",
  "</reciprocal>",
  "",
  "<waitlist>",
  "Members can add themselves to unlimited waitlists at any location. Waitlist notifications are sent via email only (not phone or text).",
  "</waitlist>",
  "",
  "<offshore_limits>",
  "Jacksonville Beach/Mayport: 15 NM offshore limit.",
  "St. Augustine: 25 NM offshore limit.",
  "GPS grace zone: 0.5 NM.",
  "Inshore: 25 navigable miles from departure location.",
  "</offshore_limits>",
  "",
  "<weather_policy>",
  "SCA inshore (0-20 mi): Full shutdown at St. Augustine and Jacksonville Beach.",
  "SCA offshore only (20-60 mi): Offshore restricted, inshore up to 15 mi allowed if no inshore restriction.",
  "SCEC inshore: Offshore restricted, ICW still open.",
  "Gale warning: ALL locations closed including Julington Creek.",
  "Lightning: No departures. Resume 10 minutes after last strike.",
  "Fog: No departure unless visibility extends across ICW/river.",
  "Julington Creek: NOT affected by SCA. IS affected by gale, fog, lightning, and storms.",
  "Rain/cold: Club stays open, reservations not cancelled.",
  "</weather_policy>",
  "",
  "<whats_included>",
  "Unlimited boat usage (no hourly fees), all maintenance, cleaning, storage, and insurance, unlimited free training with USCG-licensed captains, safety equipment on every vessel, online reservation access, and social events.",
  "</whats_included>",
  "",
  "<member_costs>",
  "Monthly dues (year-round), fuel used, no-show and late fees, admin fees for incidents, retraining fuel costs.",
  "</member_costs>",
  "",
  "<rules>",
  "Only members may operate boats (non-member operating = no insurance coverage). Impaired operation results in suspension or termination. Keep phone on for dock calls while on the water. VHF Channel 16 must be on for offshore trips. Return boat in good condition. Fishing only on designated boats, no fish cleaning aboard, rinse boat after fishing. No grills on boats. Pets allowed (must be under control, damage charged to member, bring pet PFDs). No commercial use. Water sports on designated boats only. No storing personal items at club. Do not attempt repairs. No towing other vessels.",
  "</rules>",
  "",
  "<life_jackets>",
  "FBC provides adult PFDs (90 lbs+). Florida law: children under 6 must wear PFD on vessels under 26 ft. Federal law (offshore past 3 mi): children under 13 must wear PFD. Children over 6 but under 90 lbs: member must bring an appropriate child-sized PFD.",
  "</life_jackets>",
  "",
  "<pom_elite>",
  "Peace of Mind Elite (POM Elite) is our optional Deductible Reduction Program.",
  "",
  "Standard coverage (included with every membership):",
  "- $2,500 deductible for Liability",
  "- $2,500 deductible for Physical Damage",
  "- $1M Liability coverage",
  "- $300K Uninsured Boater coverage",
  "- $5K Medical Claim coverage",
  "- Towing for mechanical issues only",
  "",
  "Peace of Mind Elite ($750/year or $70/month):",
  "- $0 deductible for Liability",
  "- $0 deductible for Physical Damage",
  "- All standard coverages PLUS:",
  "- Towing for operator error (not just mechanical)",
  "- Deductible coverage for 2 incidents per plan year (home or reciprocal)",
  "- Equipment coverage: 2 anchors and 2 props per plan year",
  "",
  "POM Elite requires a 1-year commitment, is non-refundable, and auto-renews unless the member opts out. First monthly payment is prorated based on enrollment date. Special terms apply for Corporate and Friends & Family memberships.",
  "",
  "Always encourage members to purchase or renew POM Elite, especially when discussing incidents, towing, or equipment costs. When mentioning POM, always clarify it stands for Peace of Mind Elite — never say \"Proof of Means.\"",
  "</pom_elite>",
  "",
  "<equipment_costs>",
  "Without POM Elite: Fender $35, Aluminum Prop $145, Anchor Kit $225, Towing $350, Stainless Prop $1,125, Bimini Damage $900-$2,200, Cowling Damage $425-$1,800. All charges subject to sales tax; additional labor charges may apply. Pricing subject to change. With POM Elite, 2 anchors and 2 props per year are covered.",
  "</equipment_costs>",
  "",
  "<incident_policies>",
  "Without POM: Grounding + tow = $350 fee. 2nd grounding = suspension + $350 retraining. 3rd grounding = termination. High and dry + tow = $350 fee.",
  "With POM Elite: Towing for operator error is covered.",
  "Vessel contact: Suspension until retrained. 2nd = $250 fee. 3rd = termination.",
  "Dock behavior: 1st = warning. 2nd = 30-day suspension. 3rd = termination.",
  "Sober Skipper policy: Vessel not released if member appears impaired. Self-report = $250 + 30-day suspension. 2nd offense = termination.",
  "Late return 60+ min: Automatic 30-day suspension.",
  "Operating between sunset and sunrise: Immediate termination.",
  "</incident_policies>",
  "",
  "<insurance_exclusions>",
  "No coverage for: diving activities, commercial use, exceeding nautical limits, overland transit, rule violations, or non-member operating the vessel.",
  "</insurance_exclusions>",
  "",
  "<cancellation>",
  "60 days written notice required. No long-term commitments. Contact the Membership Experience Center to submit cancellation notice.",
  "</cancellation>",
  "",
  "<hold>",
  "Members may place membership on hold for a minimum of 12 months per the current Hold Policy. Contact the Membership Experience Center for details and fees. Corporate and Friends & Family memberships may NOT be placed on hold.",
  "</hold>",
  "",
  "<transfer>",
  "Requires 1+ year in good standing. $500 transfer fee to receiving club. New agreement at new club's current rates. Subject to approval and availability.",
  "</transfer>",
  "",
  "<friends_family_note>",
  "If all but 1-2 co-resident members of a Friends & Family plan terminate, the membership auto-upgrades to a Freedom Boating Plan at the current rate plus a conversion fee.",
  "</friends_family_note>",
  "",
  "<contact>",
  "Phone: 904-329-7456",
  "Email: bedinger@freedomboatclub.com",
  "Dock email: fbcdocksjax@freedomboatclub.com",
  "Website: freedomboatclub.com",
  "Reservations: reservations.freedomboatclub.com",
  "</contact>",
  "",
  "</knowledge_base>"
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

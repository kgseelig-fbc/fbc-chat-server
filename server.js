var express = require("express");
var cors = require("cors");
var path = require("path");
var fs = require("fs");
var https = require("https");
var crypto = require("crypto");
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
// Storage — in memory, mirrored to JSON files when DATA_DIR is set (a Railway volume).
// Without DATA_DIR everything is lost on restart, as before.
// ---------------------------------------------------------------------------
var leads = [];
var conversations = {};
var DATA_DIR = process.env.DATA_DIR || "";

function dataPath(name) { return path.join(DATA_DIR, name + ".json"); }

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(dataPath(name), "utf8")); }
  catch (e) {
    if (e.code !== "ENOENT") console.error("Could not read " + name + ".json:", e.message);
    return fallback;
  }
}

function loadData() {
  if (!DATA_DIR) return;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.error("DATA_DIR " + DATA_DIR + " is unusable, running in memory only:", e.message); DATA_DIR = ""; return; }
  var l = readJson("leads", []);
  var c = readJson("conversations", {});
  leads = Array.isArray(l) ? l : [];
  conversations = (c && typeof c === "object" && !Array.isArray(c)) ? c : {};
  console.log("Loaded " + leads.length + " leads and " + Object.keys(conversations).length + " conversations from " + DATA_DIR);
}

function serialize(name) { return JSON.stringify(name === "leads" ? leads : conversations); }

// Saves are debounced (2s) and atomic: write a temp file, then rename over the real one,
// so a crash mid-write can never leave a half-written file to load next boot.
var saveTimers = {};
function scheduleSave(name) {
  if (!DATA_DIR || saveTimers[name]) return;
  saveTimers[name] = setTimeout(function() {
    saveTimers[name] = null;
    var file = dataPath(name), tmp = file + ".tmp";
    fs.writeFile(tmp, serialize(name), function(err) {
      if (err) return console.error("Could not write " + name + ".json:", err.message);
      fs.rename(tmp, file, function(err2) { if (err2) console.error("Could not save " + name + ".json:", err2.message); });
    });
  }, 2000);
}

// Railway sends SIGTERM on redeploy; flush anything still debounced before exiting.
function flushSync() {
  if (!DATA_DIR) return;
  ["leads", "conversations"].forEach(function(name) {
    if (!saveTimers[name]) return;
    clearTimeout(saveTimers[name]);
    saveTimers[name] = null;
    try {
      fs.writeFileSync(dataPath(name) + ".tmp", serialize(name));
      fs.renameSync(dataPath(name) + ".tmp", dataPath(name));
    } catch (e) { console.error("Could not flush " + name + ".json:", e.message); }
  });
}
["SIGTERM", "SIGINT"].forEach(function(sig) {
  process.on(sig, function() { flushSync(); process.exit(0); });
});

loadData();

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
  html += "<tr><td style='padding:8px 16px;background:#0B1D3A;color:white;font-weight:bold;'>Bot Health Checks</td><td style='padding:8px 16px;border:1px solid #ddd;'>" + health.passed + " passed, " + health.failed + " failed (since last restart)</td></tr>";
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

// Eastern-time hour (0-23) and short weekday name for a date. The server runs in UTC.
var ET_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false, weekday: "short" });
function etHourAndDay(date) {
  var out = { hour: 0, day: "Sun" };
  ET_FORMAT.formatToParts(date).forEach(function(p) {
    if (p.type === "hour") out.hour = parseInt(p.value, 10) % 24;
    if (p.type === "weekday") out.day = p.value;
  });
  return out;
}

// Send weekly summary every Monday at 8am ET. Checks every 30s and remembers the last
// send date so a tick landing on 7:59:59 then 8:01:00 can't skip the window.
var lastSummaryDate = "";
setInterval(function() {
  var et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  var today = et.toDateString();
  if (et.getDay() === 1 && et.getHours() === 8 && et.getMinutes() < 5 && lastSummaryDate !== today) {
    lastSummaryDate = today;
    sendWeeklySummary();
  }
}, 30000);

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
function safeEqual(a, b) {
  // Hash both sides so the comparison is constant-time and leaks nothing about length.
  var ha = crypto.createHash("sha256").update(String(a)).digest();
  var hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkAuth(req) {
  var pw = process.env.ADMIN_PASSWORD || "fbc2024";
  var supplied = req.headers["x-admin-password"] || (req.body && req.body.password) || "";
  return safeEqual(supplied, pw);
}

// ---------------------------------------------------------------------------
// Lead endpoints
// ---------------------------------------------------------------------------
var LEAD_STATUSES = ["new", "contacted", "converted", "lost"];
var LEAD_TAG = /\[LEAD_CAPTURED\]\s*(\{[^{}]*\})/;
var CONV_ID = /^[\w-]{1,100}$/;

function str(v) { return typeof v === "string" ? v.trim() : (v == null ? "" : String(v)); }

// Validate and store a lead. Returns { lead } or { error }. A second capture from the
// same conversation (e.g. the prospect adds their email later) updates the existing lead
// instead of creating a duplicate.
function recordLead(fields, conversationId) {
  fields = fields || {};
  var name = str(fields.name), phone = str(fields.phone), email = str(fields.email);
  var zip = str(fields.zip), locationInterest = str(fields.locationInterest);
  if (!name && !phone && !email) return { error: "At least one of name, phone, or email is required" };
  if (name.length > 200) return { error: "Name exceeds maximum length" };
  if (phone.length > 30) return { error: "Phone exceeds maximum length" };
  if (email.length > 200) return { error: "Email exceeds maximum length" };
  if (zip.length > 20) return { error: "Zip exceeds maximum length" };
  if (locationInterest.length > 200) return { error: "Location exceeds maximum length" };
  conversationId = CONV_ID.test(conversationId) && conversationId !== "unknown" ? conversationId : "";

  var existing = null;
  if (conversationId) {
    for (var i = 0; i < leads.length; i++) {
      if (leads[i].conversationId === conversationId) { existing = leads[i]; break; }
    }
  }
  if (existing) {
    var changed = false;
    var updates = { name: name, phone: phone, email: email, zip: zip, locationInterest: locationInterest };
    Object.keys(updates).forEach(function(k) {
      if (updates[k] && updates[k] !== existing[k]) { existing[k] = updates[k]; changed = true; }
    });
    if (changed) {
      console.log("LEAD UPDATED:", existing.name, existing.phone, existing.email);
      sendLeadEmail(existing);
      scheduleSave("leads");
    }
    return { lead: existing, updated: true };
  }

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
  scheduleSave("leads");
  return { lead: lead };
}

// The model appends [LEAD_CAPTURED]{json} when it has collected a prospect's details.
// Record the lead here so capture doesn't depend on the browser, and strip the tag
// so neither the member nor the dashboard transcript sees it.
function captureLeadFromReply(reply, conversationId) {
  var m = reply.match(LEAD_TAG);
  if (!m) return reply;
  try {
    var result = recordLead(JSON.parse(m[1]), conversationId);
    if (result.error) console.warn("Lead tag rejected:", result.error);
  } catch (e) {
    console.error("Lead tag parse error:", e.message, m[1].slice(0, 200));
  }
  return reply.replace(LEAD_TAG, "").trim();
}

// Kept for older cached copies of the widget, which still POST leads themselves.
app.post("/api/lead", leadLimiter, validateOrigin, function(req, res) {
  var result = recordLead(req.body, str(req.body.conversationId));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true, id: result.lead.id });
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
  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.body.status !== undefined && LEAD_STATUSES.indexOf(req.body.status) === -1) return res.status(400).json({ error: "Invalid status" });
  if (req.body.notes !== undefined && (typeof req.body.notes !== "string" || req.body.notes.length > 5000)) return res.status(400).json({ error: "Invalid notes" });
  for (var i = 0; i < leads.length; i++) {
    if (leads[i].id === req.body.id) {
      if (req.body.status) leads[i].status = req.body.status;
      if (req.body.notes !== undefined) leads[i].notes = req.body.notes;
      scheduleSave("leads");
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
var CLAUDE_MODEL = "claude-sonnet-5-5";
var CLAUDE_TIMEOUT_MS = 45000;

// opts (optional): { system, maxTokens } — the health probe uses these to send a tiny request
// through the exact same code path as real chat.
function callClaude(messages, callback, opts) {
  opts = opts || {};
  var body = JSON.stringify({
    model: CLAUDE_MODEL,
    // Thinking tokens count toward max_tokens, so leave room for both thinking and the reply.
    max_tokens: opts.maxTokens || 4096,
    // Sonnet 5.5 thinks before replying by default; "low" keeps that brief for chat latency.
    output_config: { effort: "low" },
    // The knowledge base is identical on every request — cache it so only the conversation is billed at full price.
    system: opts.system ? [{ type: "text", text: opts.system }] : [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: messages
  });
  var options = {
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) }
  };
  var done = false;
  function finish(err, data, status) {
    if (done) return;
    done = true;
    callback(err, data, status);
  }
  var req = https.request(options, function(res) {
    var data = "";
    res.setEncoding("utf8");
    res.on("data", function(chunk) { data += chunk; });
    res.on("end", function() {
      var parsed;
      try { parsed = JSON.parse(data); }
      catch (e) { return finish(new Error("Bad response (HTTP " + res.statusCode + ", " + data.length + " chars): " + data.slice(0, 200))); }
      finish(null, parsed, res.statusCode);
    });
    res.on("error", function(err) { finish(err); });
  });
  req.on("error", function(err) { finish(err); });
  req.setTimeout(CLAUDE_TIMEOUT_MS, function() { req.destroy(new Error("Request timed out")); });
  req.write(body);
  req.end();
}

// Read blocks by type: with thinking on, content[0] is usually a thinking block, not text.
function textOf(data) {
  var text = "";
  ((data && data.content) || []).forEach(function(block) {
    if (block && block.type === "text" && block.text) text += block.text;
  });
  return text;
}

// One retry for transient failures (overloaded, server error, dropped connection). Not for timeouts.
function callClaudeWithRetry(messages, callback) {
  callClaude(messages, function(err, data, status) {
    var retryable = err ? err.message !== "Request timed out" : (status === 529 || status === 503 || status === 500);
    if (!retryable) return callback(err, data, status);
    console.warn("Claude request failed (" + (err ? err.message : "HTTP " + status) + "), retrying once");
    setTimeout(function() { callClaude(messages, callback); }, 1500);
  });
}

var REFUSAL_REPLY = "I'm not able to help with that one, but I'm happy to answer questions about Freedom Boat Club membership, our boats, or getting out on the water. You can also call us at 904-329-7456.";

app.post("/api/chat", chatLimiter, validateOrigin, validateChatInput, function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Missing API key" });
  var messages = req.body.messages || [];
  var convId = typeof req.body.conversationId === "string" && CONV_ID.test(req.body.conversationId) ? req.body.conversationId : "unknown";
  var clean = messages.slice(-50).map(function(m) {
    return { role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 5000) };
  });
  callClaudeWithRetry(clean, function(err, data, status) {
    if (err) { console.error("Error:", err.message); noteChatFailure(); return res.status(502).json({ error: "AI unavailable" }); }
    if (status === 429 || status === 529) {
      console.warn("Claude API busy (HTTP " + status + ")");
      noteChatFailure();
      return res.status(503).json({ error: "Too many requests right now. Please wait a moment and try again." });
    }
    if (status !== 200) {
      console.error("Claude API error (HTTP " + status + "):", JSON.stringify(data).slice(0, 500));
      noteChatFailure();
      return res.status(502).json({ error: "AI unavailable" });
    }

    var reply = "";
    if (data.stop_reason === "refusal") {
      console.warn("Claude declined to answer:", JSON.stringify(data.stop_details || {}));
      reply = REFUSAL_REPLY;
    } else {
      reply = textOf(data);
      if (!reply) {
        console.error("No text in response (stop_reason " + data.stop_reason + "):", JSON.stringify(data).slice(0, 500));
        noteChatFailure();
        return res.status(502).json({ error: "AI unavailable" });
      }
      if (data.stop_reason === "max_tokens") console.warn("Reply truncated at max_tokens for conversation " + convId);
    }
    if (data.usage) {
      console.log("chat " + convId + " tokens in=" + data.usage.input_tokens + " cached=" + (data.usage.cache_read_input_tokens || 0) + " out=" + data.usage.output_tokens);
    }

    reply = captureLeadFromReply(reply, convId);

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
    scheduleSave("conversations");
    res.json({ reply: reply });
  });
});

// ---------------------------------------------------------------------------
// Health watchdog — proves the Claude path actually answers, not just that the process is up.
// (/health stayed green for the whole month the bot was down on a retired model.)
// ---------------------------------------------------------------------------
var HEALTHCHECK_INTERVAL_MIN = parseInt(process.env.HEALTHCHECK_INTERVAL_MIN || "15", 10);
if (isNaN(HEALTHCHECK_INTERVAL_MIN) || HEALTHCHECK_INTERVAL_MIN < 0) HEALTHCHECK_INTERVAL_MIN = 15;
var ALERT_EMAIL = process.env.EMAIL_ALERTS || "kseelig@freedomboatclub.com";
var REALERT_MS = 6 * 60 * 60 * 1000;

var health = { lastProbe: null, lastEmailProbe: null, consecutiveFailures: 0, alerted: false, downSince: null, lastAlertAt: 0, passed: 0, failed: 0 };
var lastProbeStartedAt = 0;

function etNow() {
  return new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
}

// One tiny real request on the production model and key, through the same callClaude as chat.
function probeClaude(callback) {
  var started = Date.now();
  if (!process.env.ANTHROPIC_API_KEY) return callback({ ok: false, reason: "ANTHROPIC_API_KEY is not set" });
  callClaude([{ role: "user", content: "Reply with the single word OK." }], function(err, data, status) {
    var latencyMs = Date.now() - started;
    if (err) return callback({ ok: false, reason: err.message, latencyMs: latencyMs });
    if (status !== 200) {
      var detail = (data && data.error && data.error.message) || JSON.stringify(data).slice(0, 200);
      return callback({ ok: false, reason: "HTTP " + status + " from Claude API: " + detail, status: status, latencyMs: latencyMs });
    }
    var text = textOf(data);
    if (!text) return callback({ ok: false, reason: "No text in response (stop_reason " + data.stop_reason + ")", status: status, latencyMs: latencyMs });
    callback({ ok: true, status: 200, latencyMs: latencyMs, reply: text.slice(0, 40) });
  }, { system: "You are a health check for a chat server. Reply with exactly: OK", maxTokens: 128 });
}

// SMTP login check — catches a rotated Gmail app password, which otherwise fails silently
// while leads pile up unsent. Only run from the scheduled probe to keep Gmail logins modest.
function probeEmail(callback) {
  var transport = getGmailTransport();
  if (!transport) return callback({ ok: true, skipped: true, reason: "Gmail not configured" });
  var started = Date.now();
  transport.verify(function(err) {
    transport.close();
    callback(err ? { ok: false, reason: err.message, latencyMs: Date.now() - started } : { ok: true, latencyMs: Date.now() - started });
  });
}

function runProbe(source, callback) {
  lastProbeStartedAt = Date.now();
  probeClaude(function(result) {
    recordProbe(result, source);
    if (callback) callback(result);
  });
}

function recordProbe(result, source) {
  result.at = new Date().toISOString();
  result.source = source;
  health.lastProbe = result;
  if (result.ok) {
    health.passed++;
    if (health.alerted) {
      var downMin = Math.round((Date.now() - new Date(health.downSince).getTime()) / 60000);
      console.log("Health probe OK again after about " + downMin + " min down");
      sendHealthEmail("RESOLVED: FBC chat bot is responding again",
        "<p>The chat bot at chat.freedomboatclub.ai is answering again as of " + etNow() + " ET, after about " + downMin + " minutes down.</p>" +
        "<p>Last check took " + result.latencyMs + " ms.</p>");
    }
    health.consecutiveFailures = 0;
    health.alerted = false;
    health.downSince = null;
    return;
  }
  health.failed++;
  health.consecutiveFailures++;
  if (!health.downSince) health.downSince = result.at;
  console.error("Health probe FAILED (" + source + ", " + health.consecutiveFailures + " in a row): " + result.reason);
  if (health.consecutiveFailures === 1) {
    // A single failure can be a blip; confirm a minute later before alerting anyone.
    setTimeout(function() { runProbe("retry"); }, 60000).unref();
    return;
  }
  if (!health.alerted || Date.now() - health.lastAlertAt > REALERT_MS) {
    health.alerted = true;
    health.lastAlertAt = Date.now();
    var railwayUrl = process.env.RAILWAY_PROJECT_ID
      ? "https://railway.com/project/" + process.env.RAILWAY_PROJECT_ID + (process.env.RAILWAY_SERVICE_ID ? "/service/" + process.env.RAILWAY_SERVICE_ID : "")
      : "https://railway.com";
    sendHealthEmail("ALERT: FBC chat bot is not responding",
      "<h2>The FBC chat bot is not answering</h2>" +
      "<p>Since " + new Date(health.downSince).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET &mdash; " + health.consecutiveFailures + " failed checks in a row.</p>" +
      "<p><strong>Reason:</strong> " + escHtml(result.reason) + "</p>" +
      "<p>Visitors to the chat widget currently see \"I'm having trouble right now\" instead of answers.</p>" +
      "<h3>What to check</h3><ol>" +
      "<li>Server logs on Railway: <a href='" + railwayUrl + "'>" + railwayUrl + "</a></li>" +
      "<li>Anthropic status page: <a href='https://status.claude.com'>status.claude.com</a></li>" +
      "<li>API key and billing: <a href='https://platform.claude.com'>platform.claude.com</a></li></ol>" +
      "<p>This check runs every " + HEALTHCHECK_INTERVAL_MIN + " minutes. You will get a RESOLVED email when it recovers, and a reminder every 6 hours while it stays down.</p>");
  }
}

function recordEmailProbe(result) {
  result.at = new Date().toISOString();
  var was = health.lastEmailProbe;
  health.lastEmailProbe = result;
  if (!result.ok) console.error("Email check FAILED: " + result.reason);
  else if (was && !was.ok) console.log("Email check OK again");
}

function sendHealthEmail(subject, html) {
  var transport = getGmailTransport();
  if (!transport) { console.warn("Gmail not configured - cannot send health email: " + subject); return; }
  transport.sendMail({
    from: '"FBC Chat Monitor" <' + process.env.GMAIL_USER + '>',
    to: ALERT_EMAIL,
    subject: subject,
    html: html
  }, function(err) { if (err) console.error("Health email error:", err.message); else console.log("Health email sent: " + subject); });
}

// Real traffic failing is the strongest signal there is; confirm with a probe, at most once a minute.
function noteChatFailure() {
  if (HEALTHCHECK_INTERVAL_MIN === 0) return;
  if (Date.now() - lastProbeStartedAt < 60000) return;
  runProbe("traffic");
}

if (HEALTHCHECK_INTERVAL_MIN > 0) {
  // Probe shortly after boot so a broken deploy is caught within a couple of minutes.
  setTimeout(function() { runProbe("startup"); probeEmail(recordEmailProbe); }, 20000).unref();
  setInterval(function() { runProbe("scheduled"); probeEmail(recordEmailProbe); }, HEALTHCHECK_INTERVAL_MIN * 60000).unref();
}

var healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  message: { error: "Too many health checks. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false
});

// Deep health check for an external uptime monitor: runs a real probe and answers 200 when the
// bot responds, 503 when it does not (or when the last email check failed). Disabled unless
// HEALTHCHECK_TOKEN is set, so nobody can spend API calls anonymously.
app.get("/api/health/deep", healthLimiter, function(req, res) {
  var token = process.env.HEALTHCHECK_TOKEN;
  if (!token) return res.status(404).json({ error: "Not found" });
  var supplied = req.query.token || req.headers["x-healthcheck-token"] || "";
  if (!safeEqual(supplied, token)) return res.status(401).json({ error: "Unauthorized" });
  runProbe("deep", function(result) {
    var email = health.lastEmailProbe;
    var emailOk = !email || email.ok;
    res.status(result.ok && emailOk ? 200 : 503).json({
      ok: result.ok && emailOk,
      claude: { ok: result.ok, reason: result.reason || null, latencyMs: result.latencyMs, model: CLAUDE_MODEL },
      email: email || { skipped: true, reason: "not checked yet" },
      checkedAt: result.at,
      consecutiveFailures: health.consecutiveFailures
    });
  });
});

app.get("/api/status", adminLimiter, function(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  res.json({ health: health, model: CLAUDE_MODEL, intervalMin: HEALTHCHECK_INTERVAL_MIN, storage: DATA_DIR ? "persisted" : "memory", uptimeSec: Math.round(process.uptime()) });
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
    var when = etHourAndDay(new Date(c.startedAt));
    hourCounts[when.hour]++;
    dayCounts[when.day]++;
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
  if (!process.env.ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD not set - dashboard is using the default password");
  console.log("Storage: " + (DATA_DIR ? "persisted to " + DATA_DIR : "in memory only (set DATA_DIR to a volume path to persist)"));
  console.log("Health checks: " + (HEALTHCHECK_INTERVAL_MIN > 0 ? "every " + HEALTHCHECK_INTERVAL_MIN + " min, alerts to " + ALERT_EMAIL : "disabled") + (process.env.HEALTHCHECK_TOKEN ? "; /api/health/deep enabled" : "; /api/health/deep disabled (set HEALTHCHECK_TOKEN)"));
  console.log("Dashboard: /dashboard");
});

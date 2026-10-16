// Smoke test: boots server.js with https.request replaced by a scripted fake Anthropic API,
// then drives the public and admin endpoints over real HTTP. No network, no API key needed.
// Run with `npm test`. Add a case here whenever /api/chat or lead handling changes.
process.env.PORT = "3999";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "secret-pw";
process.env.HEALTHCHECK_INTERVAL_MIN = "0"; // no timer-driven probes during the test; the deep endpoint drives them
process.env.HEALTHCHECK_TOKEN = "probe-token";
delete process.env.GMAIL_USER; // no email attempts

// Persistence: seed a data dir so we can check it loads at boot and saves after changes.
var fs = require("fs");
var os = require("os");
var path = require("path");
var DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fbc-smoke-"));
process.env.DATA_DIR = DATA_DIR;
fs.writeFileSync(path.join(DATA_DIR, "leads.json"), JSON.stringify([
  { id: "lead_seed", name: "Seeded Lead", phone: "904-555-0000", email: "", zip: "", locationInterest: "", conversationId: "", capturedAt: "2026-01-01T00:00:00.000Z", status: "contacted", notes: "" }
]));

var https = require("https");
var http = require("http");
var EventEmitter = require("events");

var scripted = [];   // queue of { status, body } the fake API returns, in order
var captured = [];   // request bodies the server sent to the fake API
https.request = function (opts, cb) {
  var req = new EventEmitter();
  req.write = function (b) { req.body = b; };
  req.setTimeout = function () {};
  req.destroy = function () {};
  req.end = function () {
    captured.push(JSON.parse(req.body));
    var s = scripted.shift();
    if (!s) { console.error("fake API: no scripted response left; answering 500"); s = { status: 500, body: JSON.stringify({ type: "error", error: { type: "api_error", message: "unscripted request" } }) }; }
    var res = new EventEmitter();
    res.statusCode = s.status;
    res.setEncoding = function (enc) { res.enc = enc; };
    setImmediate(function () {
      cb(res);
      var buf = Buffer.from(s.body, "utf8");
      // Deliver in two chunks, splitting at a chosen byte so multi-byte chars straddle the boundary.
      var cut = s.cut != null ? s.cut : Math.floor(buf.length / 2);
      var a = buf.slice(0, cut), b = buf.slice(cut);
      // Real Node: setEncoding installs a StringDecoder that carries partial multi-byte
      // sequences across chunks; without it, 'data' delivers raw Buffers.
      var dec = res.enc ? new (require("string_decoder").StringDecoder)(res.enc) : null;
      res.emit("data", dec ? dec.write(a) : a);
      res.emit("data", dec ? dec.write(b) : b);
      if (dec) { var tail = dec.end(); if (tail) res.emit("data", tail); }
      res.emit("end");
    });
  };
  return req;
};

require(require("path").join(__dirname, "..", "server.js"));

function call(method, path, body, headers) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var h = Object.assign({ "Content-Type": "application/json" }, headers || {});
    if (data) h["Content-Length"] = Buffer.byteLength(data);
    var req = http.request({ host: "127.0.0.1", port: 3999, method: method, path: path, headers: h }, function (res) {
      var out = "";
      res.on("data", function (c) { out += c; });
      res.on("end", function () { resolve({ status: res.statusCode, body: out }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

var failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + detail));
  if (!cond) failures++;
}

function apiMsg(blocks, extra) {
  return JSON.stringify(Object.assign({
    id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5",
    content: blocks, stop_reason: "end_turn", stop_details: null,
    usage: { input_tokens: 120, cache_read_input_tokens: 4800, output_tokens: 60 }
  }, extra || {}));
}

setTimeout(async function () {
  try {
    // 1. Thinking block first, em-dash split across chunks, lead tag at the end.
    var text = "Great question — our plans start at $329 a month.\nI've got your details!\n[LEAD_CAPTURED]{\"name\":\"Kim Test\",\"phone\":\"904-555-0100\",\"email\":\"\",\"zip\":\"32250\",\"locationInterest\":\"Jacksonville Beach\"}";
    var body1 = apiMsg([{ type: "thinking", thinking: "", signature: "abc" }, { type: "text", text: text }]);
    var dashByte = Buffer.from(body1, "utf8").indexOf(Buffer.from("—", "utf8")) + 1; // split inside the 3-byte em-dash
    scripted.push({ status: 200, body: body1, cut: dashByte });
    var r = await call("POST", "/api/chat", { messages: [{ role: "user", content: "How much does it cost?" }], conversationId: "c_test_1" });
    var j = JSON.parse(r.body);
    check("chat 200", r.status === 200, r.body);
    check("reply has text from the text block (not thinking)", j.reply && j.reply.indexOf("Great question") === 0, r.body);
    check("em-dash survives chunk split", j.reply.indexOf("—") !== -1, JSON.stringify(j.reply));
    check("lead tag stripped from reply", j.reply.indexOf("LEAD_CAPTURED") === -1 && /details!$/.test(j.reply), JSON.stringify(j.reply));
    var sent = captured[0];
    check("request: effort low", sent.output_config && sent.output_config.effort === "low", JSON.stringify(sent.output_config));
    check("request: no thinking param", sent.thinking === undefined, JSON.stringify(sent.thinking));
    check("request: system is cached array", Array.isArray(sent.system) && sent.system[0].cache_control && sent.system[0].cache_control.type === "ephemeral" && sent.system[0].text.length > 5000, JSON.stringify(sent.system).slice(0, 120));
    check("request: max_tokens 4096", sent.max_tokens === 4096, sent.max_tokens);

    r = await call("GET", "/api/leads", null, { "X-Admin-Password": "secret-pw" });
    var leads = JSON.parse(r.body).leads;
    var byConv = function (list, cid) { return list.filter(function (l) { return l.conversationId === cid; }); };
    check("seeded lead loaded from DATA_DIR at boot", leads.some(function (l) { return l.id === "lead_seed" && l.status === "contacted"; }), r.body);
    check("lead recorded server-side", byConv(leads, "c_test_1").length === 1 && byConv(leads, "c_test_1")[0].name === "Kim Test", r.body);

    // 2. Second tag in the same conversation updates the lead instead of duplicating it.
    scripted.push({ status: 200, body: apiMsg([{ type: "text", text: "Got it!\n[LEAD_CAPTURED]{\"name\":\"Kim Test\",\"phone\":\"904-555-0100\",\"email\":\"kim@example.com\",\"zip\":\"32250\",\"locationInterest\":\"Jacksonville Beach\"}" }]) });
    r = await call("POST", "/api/chat", { messages: [{ role: "user", content: "kim@example.com" }], conversationId: "c_test_1" });
    r = await call("GET", "/api/leads", null, { "X-Admin-Password": "secret-pw" });
    leads = JSON.parse(r.body).leads;
    check("second tag updates existing lead (no duplicate)", byConv(leads, "c_test_1").length === 1 && byConv(leads, "c_test_1")[0].email === "kim@example.com", r.body);
    leads = byConv(leads, "c_test_1"); // later status tests target this lead

    // 3. Conversation transcript has the tag stripped and is in ET-aware analytics.
    r = await call("GET", "/api/conversations/c_test_1", null, { "X-Admin-Password": "secret-pw" });
    var conv = JSON.parse(r.body);
    check("stored transcript has no lead JSON", JSON.stringify(conv.messages).indexOf("LEAD_CAPTURED") === -1, r.body.slice(0, 300));
    r = await call("GET", "/api/analytics", null, { "X-Admin-Password": "secret-pw" });
    var an = JSON.parse(r.body);
    var hourSum = Object.keys(an.hourly).reduce(function (a, k) { return a + an.hourly[k]; }, 0);
    check("analytics counts conversation once", an.totalConversations === 1 && hourSum === 1, r.body.slice(0, 200));

    // 4. Overloaded upstream: 529 twice (one retry) -> 503 with a "Too many" message for the widget.
    scripted.push({ status: 529, body: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) });
    scripted.push({ status: 529, body: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) });
    r = await call("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }], conversationId: "c_test_2" });
    check("529 -> 503 'Too many' after one retry", r.status === 503 && JSON.parse(r.body).error.indexOf("Too many") === 0 && scripted.length === 0, r.status + " " + r.body);

    // 5. Transient 500 then success -> retry recovers.
    scripted.push({ status: 500, body: JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }) });
    scripted.push({ status: 200, body: apiMsg([{ type: "text", text: "Recovered." }]) });
    r = await call("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }], conversationId: "c_test_3" });
    check("500 then 200 -> reply", r.status === 200 && JSON.parse(r.body).reply === "Recovered.", r.status + " " + r.body);

    // 6. Non-JSON body twice -> 502, and the process is still alive.
    scripted.push({ status: 200, body: "<html>gateway</html>" });
    scripted.push({ status: 200, body: "<html>gateway</html>" });
    r = await call("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }], conversationId: "c_test_4" });
    check("garbage body -> 502", r.status === 502, r.status + " " + r.body);

    // 7. Refusal -> friendly canned reply.
    scripted.push({ status: 200, body: apiMsg([{ type: "thinking", thinking: "", signature: "x" }], { stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" } }) });
    r = await call("POST", "/api/chat", { messages: [{ role: "user", content: "..." }], conversationId: "c_test_5" });
    check("refusal -> canned reply", r.status === 200 && JSON.parse(r.body).reply.indexOf("904-329-7456") !== -1, r.status + " " + r.body);

    // 8. Only-thinking, no text (e.g. max_tokens hit mid-think) -> 502, not a crash.
    scripted.push({ status: 200, body: apiMsg([{ type: "thinking", thinking: "", signature: "x" }], { stop_reason: "max_tokens" }) });
    scripted.push({ status: 200, body: apiMsg([{ type: "thinking", thinking: "", signature: "x" }], { stop_reason: "max_tokens" }) });
    r = await call("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }], conversationId: "c_test_6" });
    check("no text block -> 502", r.status === 502, r.status + " " + r.body);
    // (two scripted because status 200 with no text is not retried — verify only one was consumed)
    check("no retry on a 200 without text", scripted.length === 1, "left=" + scripted.length);
    scripted.length = 0;

    // 9. Admin auth and validation.
    r = await call("GET", "/api/leads", null, { "X-Admin-Password": "wrong" });
    check("wrong password -> 401", r.status === 401, r.status);
    r = await call("GET", "/api/leads", null, { "X-Admin-Password": "secret-p" });
    check("prefix of password -> 401", r.status === 401, r.status);
    r = await call("POST", "/api/leads/status", { id: leads[0].id, status: "hacked" }, { "X-Admin-Password": "secret-pw" });
    check("invalid status -> 400", r.status === 400, r.status + " " + r.body);
    r = await call("POST", "/api/leads/status", { id: leads[0].id, status: "contacted", notes: "called back" }, { "X-Admin-Password": "secret-pw" });
    check("valid status update -> 200", r.status === 200, r.status + " " + r.body);
    r = await call("POST", "/api/leads/status", { id: leads[0].id, status: "lost" }, { "X-Admin-Password": "secret-pw" });
    check("password via header only (body password also works)", r.status === 200, r.status);
    r = await call("POST", "/api/leads/status", { id: leads[0].id, status: "lost", password: "secret-pw" });
    check("password via body works", r.status === 200, r.status);

    // 10. /api/lead fallback endpoint: origin check and validation.
    r = await call("POST", "/api/lead", { name: "Evil", phone: "1" }, { Origin: "https://attacker.example" });
    check("/api/lead bad origin -> 403", r.status === 403, r.status);
    r = await call("POST", "/api/lead", { name: "Fallback Lead", phone: "904-555-0199", conversationId: "c_fb_1" }, { Origin: "https://chat.freedomboatclub.ai" });
    check("/api/lead good origin -> 200", r.status === 200, r.status + " " + r.body);
    r = await call("POST", "/api/lead", {}, {});
    check("/api/lead empty -> 400", r.status === 400, r.status);

    // 10b. Deep health check and the watchdog's alert state machine.
    var cap0 = captured.length;
    r = await call("GET", "/api/health/deep");
    check("deep health without token -> 401", r.status === 401, r.status);
    r = await call("GET", "/api/health/deep?token=wrong");
    check("deep health wrong token -> 401", r.status === 401, r.status);
    scripted.push({ status: 200, body: apiMsg([{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: "OK" }]) });
    r = await call("GET", "/api/health/deep?token=probe-token");
    var dj = JSON.parse(r.body);
    check("deep health OK -> 200 ok:true", r.status === 200 && dj.ok === true && dj.claude.ok === true && dj.claude.model === "claude-sonnet-5-5", r.status + " " + r.body);
    var probeReq = captured[captured.length - 1];
    check("probe request is tiny: max_tokens 128, own system prompt, no cache marker, effort low", captured.length === cap0 + 1 && probeReq.max_tokens === 128 && /health check/i.test(probeReq.system[0].text) && probeReq.system[0].cache_control === undefined && probeReq.output_config.effort === "low", JSON.stringify(probeReq).slice(0, 300));
    scripted.push({ status: 401, body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    r = await call("GET", "/api/health/deep?token=probe-token");
    dj = JSON.parse(r.body);
    check("deep health on API 401 -> 503 with reason", r.status === 503 && dj.ok === false && /HTTP 401/.test(dj.claude.reason) && /invalid x-api-key/.test(dj.claude.reason), r.status + " " + r.body);
    r = await call("GET", "/api/status", null, { "X-Admin-Password": "secret-pw" });
    var st = JSON.parse(r.body);
    check("one failure: not alerted yet, re-check pending", st.health.consecutiveFailures === 1 && st.health.alerted === false && !!st.health.downSince, r.body.slice(0, 300));
    scripted.push({ status: 404, body: JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: claude-sonnet-5-5" } }) });
    r = await call("GET", "/api/health/deep?token=probe-token");
    check("second failure -> 503", r.status === 503, r.status + " " + r.body);
    r = await call("GET", "/api/status", null, { "X-Admin-Password": "secret-pw" });
    st = JSON.parse(r.body);
    check("two failures in a row: alerted", st.health.consecutiveFailures === 2 && st.health.alerted === true && st.health.failed === 2, r.body.slice(0, 300));
    scripted.push({ status: 200, body: apiMsg([{ type: "text", text: "OK" }]) });
    var rr = await call("GET", "/api/health/deep?token=probe-token");
    r = await call("GET", "/api/status", null, { "X-Admin-Password": "secret-pw" });
    st = JSON.parse(r.body);
    check("recovery: 200, alert cleared, counters kept", rr.status === 200 && st.health.alerted === false && st.health.consecutiveFailures === 0 && st.health.downSince === null && st.health.passed === 2 && st.health.failed === 2, rr.status + " " + r.body.slice(0, 300));
    r = await call("GET", "/api/status");
    check("/api/status without password -> 401", r.status === 401, r.status);

    // 11. Persistence: debounced saves landed on disk (2s debounce).
    await new Promise(function (ok) { setTimeout(ok, 2600); });
    var savedLeads = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "leads.json"), "utf8"));
    var savedConvs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "conversations.json"), "utf8"));
    check("leads.json saved with captured + seeded leads", savedLeads.some(function (l) { return l.id === "lead_seed"; }) && savedLeads.some(function (l) { return l.conversationId === "c_test_1" && l.status === "lost"; }), JSON.stringify(savedLeads).slice(0, 300));
    check("conversations.json saved with transcript", savedConvs.c_test_1 && savedConvs.c_test_1.messages.length === 4, Object.keys(savedConvs).join(","));
    check("no leftover .tmp files", !fs.readdirSync(DATA_DIR).some(function (f) { return /\.tmp$/.test(f); }), fs.readdirSync(DATA_DIR).join(","));

    // 12. SIGTERM flush: a real child server receives a lead and is killed before the debounce fires.
    var sigDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbc-sigterm-"));
    var child = require("child_process").spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: Object.assign({}, process.env, { PORT: "3998", DATA_DIR: sigDir, ANTHROPIC_API_KEY: "x" }), stdio: ["ignore", "pipe", "pipe"]
    });
    await new Promise(function (ok) { child.stdout.on("data", function (d) { if (String(d).indexOf("Server running") !== -1) ok(); }); });
    var r2 = await new Promise(function (resolve, reject) {
      var data = JSON.stringify({ name: "Flush Me", phone: "904-555-0777", conversationId: "c_sig" });
      var rq = http.request({ host: "127.0.0.1", port: 3998, method: "POST", path: "/api/lead", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), Origin: "https://chat.freedomboatclub.ai" } }, function (res) { var o = ""; res.on("data", function (c) { o += c; }); res.on("end", function () { resolve({ status: res.statusCode, body: o }); }); });
      rq.on("error", reject); rq.write(data); rq.end();
    });
    check("child accepted lead", r2.status === 200, r2.status + " " + r2.body);
    child.kill("SIGTERM");
    var code = await new Promise(function (ok) { child.on("exit", ok); });
    var flushed = fs.existsSync(path.join(sigDir, "leads.json")) ? JSON.parse(fs.readFileSync(path.join(sigDir, "leads.json"), "utf8")) : null;
    check("SIGTERM flushed leads.json before the debounce fired", code === 0 && flushed && flushed.length === 1 && flushed[0].name === "Flush Me", "exit=" + code + " file=" + JSON.stringify(flushed));

    // 13. Input validation still intact.
    r = await call("POST", "/api/chat", { messages: "nope" });
    check("non-array messages -> 400", r.status === 400, r.status);
    r = await call("GET", "/health");
    check("health ok", r.status === 200, r.status);

    // 14. Public pages derived from the knowledge base, and noindex on everything admin.
    var faq = require(path.join(__dirname, "..", "faq.js"));
    var guard = faq.publicTextGuard();
    function guardHits(text) { return guard.filter(function (re) { return re.test(text); }).map(String); }
    var pages = {};
    pages.faq = await call("GET", "/faq");
    pages.llms = await call("GET", "/llms.txt");
    pages.robots = await call("GET", "/robots.txt");
    pages.sitemap = await call("GET", "/sitemap.xml");
    check("/faq 200 html", pages.faq.status === 200 && /<!DOCTYPE html>/.test(pages.faq.body), pages.faq.status);
    check("/faq has one section per published knowledge-base tag", faq.SECTIONS.every(function (s) { return pages.faq.body.indexOf('<section id="' + s.tag + '">') !== -1; }), "missing section");
    var ld = pages.faq.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g).map(function (s) { return JSON.parse(s.replace(/^<script[^>]*>|<\/script>$/g, "")); });
    var faqLd = ld.filter(function (o) { return o["@type"] === "FAQPage"; })[0];
    var orgLd = ld.filter(function (o) { return o["@type"] === "Organization"; })[0];
    check("/faq FAQPage JSON-LD has every question with a non-empty answer", faqLd && faqLd.mainEntity.length === faq.SECTIONS.length && faqLd.mainEntity.every(function (q) { return q.acceptedAnswer.text.length > 20; }), JSON.stringify(faqLd).slice(0, 200));
    check("/faq Organization JSON-LD names the club and phone", orgLd && orgLd.name === "Freedom Boat Club of NE Florida" && orgLd.telephone === "+19043297456", JSON.stringify(orgLd).slice(0, 200));
    check("/faq carries facts from the prompt (dues range, phone, offshore limit)", /\$329-\$899/.test(pages.faq.body) && /904-329-7456/.test(pages.faq.body) && /15 NM offshore limit/.test(pages.faq.body), "facts missing");
    check("/faq has canonical, description and robots index", /rel="canonical" href="https:\/\/chat\.freedomboatclub\.ai\/faq"/.test(pages.faq.body) && /name="description"/.test(pages.faq.body) && /name="robots" content="index/.test(pages.faq.body), "meta missing");
    check("/faq publishes no bot instructions, staff mailboxes or internal names", guardHits(pages.faq.body).length === 0, guardHits(pages.faq.body).join(" "));
    check("/faq bot-only sentence stripped mid-line ('Always recommend the app first')", pages.faq.body.indexOf("recommend the app first") === -1, "sentence leaked");
    check("/llms.txt 200 text/plain markdown", pages.llms.status === 200 && pages.llms.body.indexOf("# Freedom Boat Club of NE Florida\n") === 0 && /\n## How do reservations work\?\n/.test(pages.llms.body), pages.llms.status + " " + pages.llms.body.slice(0, 80));
    check("/llms.txt publishes no bot instructions, staff mailboxes or internal names", guardHits(pages.llms.body).length === 0, guardHits(pages.llms.body).join(" "));
    check("/robots.txt disallows dashboard and api, points at sitemap", pages.robots.status === 200 && /Disallow: \/dashboard\n/.test(pages.robots.body) && /Disallow: \/api\/\n/.test(pages.robots.body) && /Sitemap: https:\/\/chat\.freedomboatclub\.ai\/sitemap\.xml/.test(pages.robots.body), pages.robots.body);
    check("/sitemap.xml lists /faq and /", pages.sitemap.status === 200 && /<loc>https:\/\/chat\.freedomboatclub\.ai\/faq<\/loc>/.test(pages.sitemap.body) && /<loc>https:\/\/chat\.freedomboatclub\.ai\/<\/loc>/.test(pages.sitemap.body), pages.sitemap.body);
    var robotsHdr = function (res) { return res.headers["x-robots-tag"]; };
    var hdrCall = function (p) { return new Promise(function (resolve, reject) { var rq = http.request({ host: "127.0.0.1", port: 3999, method: "GET", path: p }, function (res) { res.resume(); res.on("end", function () { resolve(res); }); }); rq.on("error", reject); rq.end(); }); };
    var hd = await hdrCall("/dashboard"), hdHtml = await hdrCall("/dashboard.html"), hApi = await hdrCall("/api/leads"), hFaq = await hdrCall("/faq"), hRoot = await hdrCall("/");
    check("X-Robots-Tag noindex on /dashboard, /dashboard.html and /api/*", /noindex/.test(robotsHdr(hd)) && /noindex/.test(robotsHdr(hdHtml)) && /noindex/.test(robotsHdr(hApi)), [robotsHdr(hd), robotsHdr(hdHtml), robotsHdr(hApi)].join("|"));
    check("no X-Robots-Tag on / and /faq", robotsHdr(hFaq) === undefined && robotsHdr(hRoot) === undefined, [robotsHdr(hFaq), robotsHdr(hRoot)].join("|"));
    var logo = await hdrCall("/logo.png");
    check("/logo.png served as image/png for OG and schema", logo.statusCode === 200 && logo.headers["content-type"] === "image/png", logo.statusCode + " " + logo.headers["content-type"]);
  } catch (e) {
    console.error("TEST ERROR", e);
    failures++;
  }
  console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}, 400);

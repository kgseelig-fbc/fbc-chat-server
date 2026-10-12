// Smoke test: boots server.js with https.request replaced by a scripted fake Anthropic API,
// then drives the public and admin endpoints over real HTTP. No network, no API key needed.
// Run with `npm test`. Add a case here whenever /api/chat or lead handling changes.
process.env.PORT = "3999";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_PASSWORD = "secret-pw";
delete process.env.GMAIL_USER; // no email attempts

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
    if (!s) throw new Error("fake API: no scripted response left");
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
    check("lead recorded server-side", leads.length === 1 && leads[0].name === "Kim Test" && leads[0].conversationId === "c_test_1", r.body);

    // 2. Second tag in the same conversation updates the lead instead of duplicating it.
    scripted.push({ status: 200, body: apiMsg([{ type: "text", text: "Got it!\n[LEAD_CAPTURED]{\"name\":\"Kim Test\",\"phone\":\"904-555-0100\",\"email\":\"kim@example.com\",\"zip\":\"32250\",\"locationInterest\":\"Jacksonville Beach\"}" }]) });
    r = await call("POST", "/api/chat", { messages: [{ role: "user", content: "kim@example.com" }], conversationId: "c_test_1" });
    r = await call("GET", "/api/leads", null, { "X-Admin-Password": "secret-pw" });
    leads = JSON.parse(r.body).leads;
    check("second tag updates existing lead (no duplicate)", leads.length === 1 && leads[0].email === "kim@example.com", r.body);

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

    // 11. Input validation still intact.
    r = await call("POST", "/api/chat", { messages: "nope" });
    check("non-array messages -> 400", r.status === 400, r.status);
    r = await call("GET", "/health");
    check("health ok", r.status === 200, r.status);
  } catch (e) {
    console.error("TEST ERROR", e);
    failures++;
  }
  console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}, 400);

// faq.js — public FAQ page, llms.txt and structured data for chat.freedomboatclub.ai.
//
// Everything here is DERIVED from the chatbot's SYSTEM_PROMPT knowledge base at
// request time, so the published FAQ can never say something different from
// what the bot says. The knowledge base is written as instructions to the model,
// so a few sentence shapes are filtered out before anything is published:
// lines that start with "Always", "Never" or "IMPORTANT:" tell the bot
// how to behave and are not facts about the club. publicTextGuard() lists the
// strings that must never reach a crawlable page; the smoke test checks it.

var SITE = {
  name: "Freedom Boat Club of NE Florida",
  shortName: "Freedom Boat Club NE Florida",
  phone: "904-329-7456",
  phoneE164: "+19043297456",
  parent: "Freedom Boat Club",
  parentUrl: "https://www.freedomboatclub.com",
  reservationsUrl: "https://reservations.freedomboatclub.com",
  area: "Jacksonville and St. Augustine, Florida",
  description: "Freedom Boat Club of NE Florida is a members-only boat club with five locations in Jacksonville Beach, Julington Creek and St. Augustine. Members get unlimited access to a private fleet of pontoons, deck boats, bay boats and offshore center consoles, with maintenance, cleaning, storage, insurance and training included."
};

// Public base URL for canonical links, the sitemap and llms.txt. Override with
// PUBLIC_URL when the service is reached under another hostname.
function baseUrl() {
  return (process.env.PUBLIC_URL || "https://chat.freedomboatclub.ai").replace(/\/+$/, "");
}

// Which knowledge-base sections are published, in display order, and the
// question each one answers. A tag listed here that is missing from the prompt
// throws at boot (see sections()), so a prompt rename cannot silently drop an
// answer from the public page.
var SECTIONS = [
  { tag: "about", question: "What is Freedom Boat Club of NE Florida?" },
  { tag: "locations", question: "Where are your docks located?" },
  { tag: "local_access", question: "Can members use all five locations?" },
  { tag: "membership_plans", question: "What membership plans do you offer?" },
  { tag: "pricing", question: "How much does Freedom Boat Club cost?" },
  { tag: "whats_included", question: "What is included in a membership?" },
  { tag: "member_costs", question: "What do members pay beyond monthly dues?" },
  { tag: "eligibility", question: "Who can join, and what training is required?" },
  { tag: "fleet", question: "What boats are in the fleet?" },
  { tag: "hours", question: "What are the dock hours and reservation time slots?" },
  { tag: "reservations", question: "How do reservations work?" },
  { tag: "reservation_weight", question: "How are weekend reservations counted?" },
  { tag: "waitlist", question: "Is there a waitlist for popular times?" },
  { tag: "overnight", question: "Can I keep a boat overnight?",
    redact: [[/ Sign overnight waiver via email to \S+@\S+\./, " Sign the overnight waiver, which the dock sends by email."]] },
  { tag: "reciprocal", question: "Can I use boats at other Freedom Boat Club locations?" },
  { tag: "offshore_limits", question: "How far offshore can I take a boat?" },
  { tag: "weather_policy", question: "What happens when the weather is bad?" },
  { tag: "rules", question: "What are the club's boating rules?" },
  { tag: "life_jackets", question: "What is the life jacket policy?" },
  { tag: "pom_elite", question: "What is Peace of Mind Elite?" },
  { tag: "equipment_costs", question: "What do towing and damaged equipment cost?" },
  { tag: "incident_policies", question: "What happens after a grounding or other incident?" },
  { tag: "insurance_exclusions", question: "What does the club's insurance not cover?" },
  { tag: "cancellation", question: "How do I cancel my membership?" },
  { tag: "hold", question: "Can I put my membership on hold?" },
  { tag: "transfer", question: "Can I transfer my membership to another club?" },
  // Staff mailboxes stay out of crawlable pages; the phone number is the public contact.
  { tag: "contact", question: "How do I contact Freedom Boat Club of NE Florida?", drop: [/^Email:/, /^Dock email:/] }
];

// Whole lines that instruct the bot rather than describe the club.
var BOT_ONLY_LINE = /^(Always|Never|IMPORTANT:)/;
// A trailing "Always ..." sentence inside an otherwise factual line.
var BOT_ONLY_SENTENCE = /\s*\bAlways [^.]*\.\s*$/;

function sectionText(prompt, tag) {
  var m = new RegExp("<" + tag + ">\\n([\\s\\S]*?)\\n</" + tag + ">").exec(prompt);
  return m ? m[1] : null;
}

// `drop`: regexes for whole lines to leave out (e.g. staff mailboxes).
// `redact`: [regex, replacement] pairs applied to the remaining lines.
function cleanLines(text, drop, redact) {
  var out = [];
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+$/, "");
    if (BOT_ONLY_LINE.test(line)) continue;
    var dropped = false;
    for (var d = 0; drop && d < drop.length; d++) { if (drop[d].test(line)) { dropped = true; break; } }
    if (dropped) continue;
    line = line.replace(BOT_ONLY_SENTENCE, "");
    for (var r = 0; redact && r < redact.length; r++) line = line.replace(redact[r][0], redact[r][1]);
    out.push(line);
  }
  // Collapse runs of blank lines and trim the ends.
  var collapsed = [];
  for (var j = 0; j < out.length; j++) {
    if (out[j] === "" && (collapsed.length === 0 || collapsed[collapsed.length - 1] === "")) continue;
    collapsed.push(out[j]);
  }
  while (collapsed.length && collapsed[collapsed.length - 1] === "") collapsed.pop();
  return collapsed;
}

// Group cleaned lines into blocks: { type: "p", text } | { type: "ul"|"ol", items: [] }.
// The knowledge base puts one complete fact per line ("Weekday dock opening: 8 AM ..."),
// so every non-list line becomes its own paragraph rather than being run together.
function toBlocks(lines) {
  var blocks = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === "") continue;
    var ul = /^- (.*)$/.exec(line);
    var ol = /^\d+\. (.*)$/.exec(line);
    if (ul || ol) {
      var type = ul ? "ul" : "ol";
      var last = blocks[blocks.length - 1];
      if (!last || last.type !== type) { last = { type: type, items: [] }; blocks.push(last); }
      last.items.push((ul || ol)[1]);
    } else {
      blocks.push({ type: "p", text: line });
    }
  }
  return blocks;
}

function blocksToText(blocks) {
  return blocks.map(function (b) {
    if (b.type === "p") return b.text;
    return b.items.map(function (it, i) { return (b.type === "ol" ? (i + 1) + ". " : "- ") + it; }).join("\n");
  }).join("\n\n");
}

// Returns [{ tag, question, lines, blocks, text }] for every published section.
function sections(prompt) {
  return SECTIONS.map(function (s) {
    var raw = sectionText(prompt, s.tag);
    if (raw === null) throw new Error("faq.js: knowledge base section <" + s.tag + "> not found in SYSTEM_PROMPT");
    var lines = cleanLines(raw, s.drop, s.redact);
    var blocks = toBlocks(lines);
    return { tag: s.tag, question: s.question, lines: lines, blocks: blocks, text: blocksToText(blocks) };
  });
}

// The <locations> section holds one dock per line: "Name: street[, unit], City, FL 12345."
// Parsed from the right so a street with its own comma (a unit number) survives.
var LOCATION_LINE = /^([^:]+): (.+), ([^,]+), ([A-Z]{2}) (\d{5})\.$/;

// Returns [{ name, street, city, state, zip }] for every dock in the knowledge base.
// Throws if the section is missing or a line does not parse, so a typo in an
// address fails at boot instead of publishing a half-formed PostalAddress.
function locations(prompt) {
  var raw = sectionText(prompt, "locations");
  if (raw === null) throw new Error("faq.js: knowledge base section <locations> not found in SYSTEM_PROMPT");
  var out = [];
  raw.split("\n").forEach(function (line) {
    line = line.replace(/\s+$/, "");
    if (!line || /^All five docks/.test(line)) return;
    var m = LOCATION_LINE.exec(line);
    if (!m) throw new Error("faq.js: <locations> line does not match 'Name: street, City, ST 12345.': " + line);
    out.push({ name: m[1], street: m[2], city: m[3], state: m[4], zip: m[5] });
  });
  if (out.length === 0) throw new Error("faq.js: <locations> has no docks");
  return out;
}

// Strings that must never appear on a crawlable page. The smoke test runs the
// rendered FAQ and llms.txt through this list.
function publicTextGuard() {
  return [
    /\bAlways\b/, /\bNever\b/, /IMPORTANT:/, /LEAD_CAPTURED/,
    /1,900/, /~1900/, /bedinger@/, /fbcdocksjax@/,
    /Slack|Fleetio|Jotform/
  ];
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function postalAddress(loc) {
  return {
    "@type": "PostalAddress",
    "streetAddress": loc.street,
    "addressLocality": loc.city,
    "addressRegion": loc.state,
    "postalCode": loc.zip,
    "addressCountry": "US"
  };
}

function organizationJsonLd(prompt) {
  var url = baseUrl();
  var docks = locations(prompt);
  var cities = [];
  docks.forEach(function (d) { if (cities.indexOf(d.city) === -1) cities.push(d.city); });
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": SITE.name,
    "alternateName": SITE.shortName,
    "url": url + "/",
    "logo": url + "/logo.png",
    "image": url + "/logo.png",
    "telephone": SITE.phoneE164,
    "description": SITE.description,
    "address": docks.map(postalAddress),
    "areaServed": cities.map(function (c) { return { "@type": "City", "name": c + ", Florida" }; }),
    // One LocalBusiness per dock, so each address is a place of its own rather
    // than five addresses on one entity.
    "department": docks.map(function (d) {
      return {
        "@type": "LocalBusiness",
        "name": SITE.parent + " " + d.name,
        "image": url + "/logo.png",
        "url": url + "/faq#locations",
        "telephone": SITE.phoneE164,
        "address": postalAddress(d),
        "parentOrganization": { "@type": "Organization", "name": SITE.name }
      };
    }),
    "parentOrganization": { "@type": "Organization", "name": SITE.parent, "url": SITE.parentUrl },
    "sameAs": [SITE.parentUrl, SITE.reservationsUrl],
    "contactPoint": { "@type": "ContactPoint", "telephone": SITE.phoneE164, "contactType": "customer service", "areaServed": "US-FL", "availableLanguage": "English" }
  };
}

function faqJsonLd(secs) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "name": SITE.name + " FAQ",
    "url": baseUrl() + "/faq",
    "inLanguage": "en-US",
    "publisher": { "@type": "Organization", "name": SITE.name, "url": baseUrl() + "/" },
    "mainEntity": secs.map(function (s) {
      return {
        "@type": "Question",
        "name": s.question,
        "acceptedAnswer": { "@type": "Answer", "text": s.text }
      };
    })
  };
}

function renderBlocks(blocks) {
  return blocks.map(function (b) {
    if (b.type === "p") return "<p>" + esc(b.text) + "</p>";
    return "<" + b.type + ">" + b.items.map(function (it) { return "<li>" + esc(it) + "</li>"; }).join("") + "</" + b.type + ">";
  }).join("\n");
}

// JSON inside <script> must not be able to close the tag.
function jsonForHtml(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

function renderFaqHtml(prompt) {
  var secs = sections(prompt);
  var url = baseUrl();
  var title = SITE.name + " FAQ: Membership, Pricing, Boats & Reservations";
  var desc = "Answers about Freedom Boat Club membership in Jacksonville and St. Augustine: plans, pricing ranges, what's included, the fleet, dock hours, reservations, weather policy and more.";
  var toc = secs.map(function (s) { return '<li><a href="#' + esc(s.tag) + '">' + esc(s.question) + "</a></li>"; }).join("\n");
  var body = secs.map(function (s) {
    return '<section id="' + esc(s.tag) + '">\n<h2>' + esc(s.question) + "</h2>\n" + renderBlocks(s.blocks) + "\n</section>";
  }).join("\n");
  var updated = new Date().toISOString().slice(0, 10);
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "<title>" + esc(title) + "</title>",
    '<meta name="description" content="' + esc(desc) + '">',
    '<meta name="robots" content="index, follow, max-snippet:-1">',
    '<link rel="canonical" href="' + url + '/faq">',
    '<link rel="alternate" type="text/plain" href="' + url + '/llms.txt" title="llms.txt">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="' + esc(SITE.name) + '">',
    '<meta property="og:title" content="' + esc(title) + '">',
    '<meta property="og:description" content="' + esc(desc) + '">',
    '<meta property="og:url" content="' + url + '/faq">',
    '<meta property="og:image" content="' + url + '/logo.png">',
    '<meta name="twitter:card" content="summary">',
    '<meta name="twitter:title" content="' + esc(title) + '">',
    '<meta name="twitter:description" content="' + esc(desc) + '">',
    '<meta name="twitter:image" content="' + url + '/logo.png">',
    '<link rel="icon" href="/logo.png" type="image/png">',
    '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet">',
    '<script type="application/ld+json">' + jsonForHtml(organizationJsonLd(prompt)) + "</script>",
    '<script type="application/ld+json">' + jsonForHtml(faqJsonLd(secs)) + "</script>",
    "<style>",
    ":root{--navy:#0B1D3A;--blue:#1B6EC2;--sky:#E8F2FC;--g50:#F8FAFB;--g200:#D8DDE5;--g600:#5A6577;--g800:#2C3544}",
    "*{box-sizing:border-box}body{margin:0;font-family:'DM Sans',system-ui,sans-serif;color:var(--g800);background:var(--g50);line-height:1.6}",
    "header{background:linear-gradient(135deg,var(--navy),#132D54);color:#fff;padding:36px 16px}",
    ".wrap{max-width:820px;margin:0 auto;padding:0 16px}",
    "header .wrap{display:flex;gap:18px;align-items:center}header img{width:64px;height:64px;border-radius:50%;background:#fff;padding:3px}",
    "h1{font-family:'Playfair Display',serif;font-size:28px;margin:0 0 6px}header p{margin:0;color:rgba(255,255,255,.75);font-size:15px}",
    "nav{background:#fff;border-bottom:1px solid var(--g200)}nav ol{columns:2;column-gap:32px;margin:0;padding:18px 16px 18px 36px;font-size:14px}nav li{break-inside:avoid;margin:3px 0}nav a{color:var(--blue);text-decoration:none}nav a:hover{text-decoration:underline}",
    "main{padding:12px 0 40px}section{background:#fff;border:1px solid var(--g200);border-radius:14px;padding:20px 22px;margin:16px 0;scroll-margin-top:16px}",
    "h2{font-family:'Playfair Display',serif;font-size:20px;color:var(--navy);margin:0 0 10px}section p{margin:8px 0}section ul,section ol{margin:8px 0;padding-left:22px}section li{margin:3px 0}",
    ".cta{background:var(--sky);border:1px solid rgba(27,110,194,.2);border-radius:14px;padding:18px 22px;margin:24px 0;font-size:15px}.cta a{color:var(--blue);font-weight:600}",
    "footer{text-align:center;color:var(--g600);font-size:13px;padding:0 16px 40px}footer a{color:var(--g600)}",
    "@media (max-width:600px){nav ol{columns:1}h1{font-size:23px}}",
    "</style>",
    "</head>",
    "<body>",
    "<header><div class=\"wrap\"><img src=\"/logo.png\" alt=\"" + esc(SITE.parent) + " logo\" width=\"64\" height=\"64\"><div>",
    "<h1>" + esc(SITE.name) + " FAQ</h1>",
    "<p>Membership, pricing, the fleet, reservations and club policies for " + esc(SITE.area) + ". Call " + esc(SITE.phone) + " or <a href=\"/\" style=\"color:#fff\">chat with us</a>.</p>",
    "</div></div></header>",
    '<nav aria-label="Questions"><ol class="wrap">' + toc + "</ol></nav>",
    '<main class="wrap">',
    body,
    '<div class="cta">Still have a question? <a href="/">Ask our chat assistant</a> or call <a href="tel:' + SITE.phoneE164 + '">' + esc(SITE.phone) + "</a> to schedule a dock tour. Exact pricing depends on the plan and current promotions, so a membership executive will confirm it with you.</div>",
    "</main>",
    "<footer>" + esc(SITE.name) + " &bull; Part of <a href=\"" + SITE.parentUrl + "\" rel=\"noopener\">" + esc(SITE.parent) + "</a> &bull; Last updated " + updated + " &bull; <a href=\"/llms.txt\">llms.txt</a></footer>",
    "</body>",
    "</html>"
  ].join("\n");
}

// https://llmstxt.org — a Markdown summary AI crawlers and answer engines can read directly.
function renderLlmsTxt(prompt) {
  var secs = sections(prompt);
  var url = baseUrl();
  var out = [
    "# " + SITE.name,
    "",
    "> " + SITE.description,
    "",
    "Locations: " + locations(prompt).map(function (d) { return d.name + " (" + d.street + ", " + d.city + ", " + d.state + " " + d.zip + ")"; }).join("; ") + ".",
    "Phone: " + SITE.phone + ". Reservations: " + SITE.reservationsUrl + ". Part of " + SITE.parent + " (" + SITE.parentUrl + ").",
    "Chat assistant: " + url + "/ — FAQ page: " + url + "/faq",
    "",
    "Exact initiation fees and monthly dues vary by plan and promotion; the ranges below are current as of the last update and a membership executive confirms pricing on a dock tour.",
    ""
  ];
  secs.forEach(function (s) {
    out.push("## " + s.question);
    out.push("");
    out.push(s.text);
    out.push("");
  });
  out.push("## Pages");
  out.push("");
  out.push("- [FAQ](" + url + "/faq): every question above as a web page with FAQPage structured data");
  out.push("- [Chat](" + url + "/): ask the club's assistant a question");
  out.push("- [Freedom Boat Club](" + SITE.parentUrl + "): the national club");
  out.push("");
  return out.join("\n");
}

function renderRobotsTxt() {
  var url = baseUrl();
  return [
    "User-agent: *",
    "Allow: /$",
    "Allow: /faq",
    "Allow: /llms.txt",
    "Allow: /logo.png",
    "Disallow: /dashboard",
    "Disallow: /api/",
    "",
    "Sitemap: " + url + "/sitemap.xml",
    ""
  ].join("\n");
}

function renderSitemapXml() {
  var url = baseUrl();
  var today = new Date().toISOString().slice(0, 10);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "<url><loc>" + url + "/faq</loc><lastmod>" + today + "</lastmod><changefreq>monthly</changefreq><priority>1.0</priority></url>",
    "<url><loc>" + url + "/</loc><lastmod>" + today + "</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>",
    "</urlset>",
    ""
  ].join("\n");
}

module.exports = {
  SITE: SITE,
  SECTIONS: SECTIONS,
  baseUrl: baseUrl,
  sections: sections,
  locations: locations,
  publicTextGuard: publicTextGuard,
  organizationJsonLd: organizationJsonLd,
  faqJsonLd: faqJsonLd,
  renderFaqHtml: renderFaqHtml,
  renderLlmsTxt: renderLlmsTxt,
  renderRobotsTxt: renderRobotsTxt,
  renderSitemapXml: renderSitemapXml
};

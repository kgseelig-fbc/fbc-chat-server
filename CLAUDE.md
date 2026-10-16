# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

FBC Chat Server (v2.1.0) — AI-powered customer service chatbot for Freedom Boat Club of NE Florida. Deployed on Railway via GitHub auto-deploy at chat.freedomboatclub.ai.

## Commands

- `npm start` or `node server.js` — start the server (default port 3000)
- `npm test` — runs `test/smoke.js`: boots the server on port 3999 against a fake Anthropic API (no network, no key) and exercises chat, lead capture, retries, refusals, admin auth and validation. Run it before every push; add a case whenever you change `/api/chat`.
- No linter or build step configured

## Required Environment Variables

`ANTHROPIC_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `ADMIN_PASSWORD` (default: "fbc2024"). Optional location-specific email routing: `EMAIL_JAX`, `EMAIL_JULINGTON`, `EMAIL_STAUGUSTINE`, `EMAIL_DEFAULT`. Optional `DATA_DIR`: directory (a Railway volume mount, e.g. `/data`) where leads and conversations are persisted as JSON; unset = in-memory only. Health watchdog: `HEALTHCHECK_INTERVAL_MIN` (default 15; `0` disables), `HEALTHCHECK_TOKEN` (enables `GET /api/health/deep?token=…` for an external uptime monitor; unset = 404), `EMAIL_ALERTS` (where outage emails go; default kseelig@freedomboatclub.com).

## Architecture

Single-file Express backend (`server.js`) serving two static frontends from `public/`.

**server.js** handles everything:
- Security middleware (Helmet, CORS locked to 4 FBC domains, rate limiting 10 req/min on `/api/chat`, origin validation, input validation)
- Claude API integration via raw `https.request` to `api.anthropic.com` (model: claude-sonnet-5-5) — not using the Anthropic SDK
  - Sonnet 5.5 thinks by default; the request sets `output_config.effort: "low"` for chat latency and `max_tokens: 4096` because thinking counts against it. Do not send `thinking: {type: "disabled"}` (400 on this model).
  - Responses are read by block `type` — `content[0]` is usually a `thinking` block, not text. `stop_reason: "refusal"` gets a canned reply.
  - The system prompt is sent as a `system` array with `cache_control: {type: "ephemeral"}` (prompt caching). The per-request log line `chat <id> tokens in=… cached=… out=…` shows whether cache reads are happening.
  - One automatic retry on 500/503/529 or a dropped connection; upstream 429/529 is returned to the widget as a 503 "Too many requests" so it shows the busy message
- Storage: leads (max 500) and conversations (max 1000) live in memory; with `DATA_DIR` set they are mirrored to `leads.json` / `conversations.json` (loaded at boot, debounced atomic saves via `scheduleSave()`, synchronous flush on SIGTERM). Without `DATA_DIR` data resets on restart. No database.
- Lead capture: `captureLeadFromReply()` parses the `[LEAD_CAPTURED]{JSON}` tag out of the model reply server-side, records the lead via `recordLead()` (one lead per conversationId — a later tag updates it), and strips the tag before the reply is stored or returned. `POST /api/lead` remains for older cached widgets.
- Lead email routing: `getEmailForLocation()` matches location keywords to env vars, CC's kseelig@freedomboatclub.com on all leads
- Conversation analysis: keyword-based sentiment detection and quality flagging (complaint, unanswered, long, negative)
- Weekly summary email via `setInterval` checking for Monday 8am ET (guarded by `lastSummaryDate` so it sends exactly once)
- Analytics hour/day buckets are computed in America/New_York via `etHourAndDay()`; the server itself runs in UTC
- Health watchdog (`probeClaude` / `recordProbe`): every `HEALTHCHECK_INTERVAL_MIN` minutes, and 20s after boot, sends a tiny real request through `callClaude` (`opts.system` / `opts.maxTokens`, no cache marker) plus an SMTP login check (`probeEmail`). One failure schedules a 60s re-check; two in a row email an ALERT to `EMAIL_ALERTS` (RESOLVED on recovery, reminder every 6h). Failed real chat requests call `noteChatFailure()` to probe immediately. `/health` only proves the process is up — it stayed green for a month while the model was retired; `/api/health/deep` is the one to monitor externally.
- System prompt (`SYSTEM_PROMPT` variable) contains the full FBC knowledge base with XML-delimited sections

**faq.js** — public, crawlable pages derived from `SYSTEM_PROMPT` at request time: `GET /faq` (HTML with `FAQPage` + `Organization` JSON-LD), `GET /llms.txt` (Markdown for AI crawlers), `GET /robots.txt`, `GET /sitemap.xml`, and `GET /logo.png` (the logo decoded from `public/logo.js`, for Open Graph tags). `SECTIONS` lists which `<knowledge_base>` tags are published and the question each answers; a listed tag missing from the prompt throws at boot. The `<locations>` section is one dock per line as `Name: street[, unit], City, FL 12345.` — `locations()` parses it into the `PostalAddress` / `LocalBusiness` entries in the Organization schema and throws on a line that does not parse, so keep that shape when editing an address. Lines that instruct the bot (starting `Always`/`Never`/`IMPORTANT:`, or a trailing "Always …" sentence) are stripped, staff mailboxes are dropped or redacted per section, and `publicTextGuard()` is the list of strings that must never reach a public page — the smoke test runs both renders through it. The FAQ is the GEO/AEO surface: edit facts in the prompt, never in faq.js, so the bot and the page cannot disagree. `PUBLIC_URL` (default `https://chat.freedomboatclub.ai`) sets canonical/sitemap URLs. `/dashboard*` and `/api/*` get `X-Robots-Tag: noindex` from a middleware ahead of `express.static`.

**public/logo.js** — defines `LOGO`, an 82K-character base64 data URI for the club logo, loaded by both pages. Don't read it; nothing else is in there.

**public/index.html** — chat widget:
- `checkForLead()` still strips `[LEAD_CAPTURED]` tags and POSTs to `/api/lead` as a fallback, but the server now strips the tag before replying so this normally never fires
- Chat history maintained client-side in `chatHistory` array

**public/dashboard.html** — admin panel:
- Password-protected (sessionStorage-based auth via `X-Admin-Password` header)
- Three tabs: Leads (status management, notes), Conversations (flag filtering, message viewer modal), Analytics (Chart.js — hourly, daily, sentiment, flags)
- Auto-refreshes leads every 30 seconds

## Key API Endpoints

Public: `POST /api/chat`, `POST /api/lead`, `GET /health` (process up only), `GET /api/health/deep?token=…` (real Claude probe; 200/503; needs `HEALTHCHECK_TOKEN`)
Crawlable (from `faq.js`): `GET /faq`, `GET /llms.txt`, `GET /robots.txt`, `GET /sitemap.xml`, `GET /logo.png`
Dashboard page: `GET /dashboard`
Admin (require password): `GET /api/leads`, `POST /api/leads/status`, `GET /api/conversations`, `GET /api/conversations/:id`, `GET /api/analytics`, `POST /api/send-summary`, `GET /api/status` (watchdog state; drives the "Bot OK / DOWN" pill in the dashboard header)

## Important Patterns

- The system prompt uses XML tags (`<role>`, `<guardrails>`, `<lead_capture>`, `<knowledge_base>`, etc.) for structured Claude parsing
- Lead capture is triggered by Claude including `[LEAD_CAPTURED]{JSON}` at the end of a response — the server (`captureLeadFromReply`) records it and strips it before the reply goes out
- All var declarations (no let/const) — the codebase uses ES5-style JavaScript throughout
- CORS allows no-origin requests (direct access, server-to-server) but blocks unrecognized origins
- The `~1,900` active member count should NOT be included in any prompts or public-facing content (`publicTextGuard()` in faq.js rejects it)

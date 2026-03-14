# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

FBC Chat Server (v2.1.0) — AI-powered customer service chatbot for Freedom Boat Club of NE Florida. Deployed on Railway via GitHub auto-deploy at chat.freedomboatclub.ai.

## Commands

- `npm start` or `node server.js` — start the server (default port 3000)
- No test suite, linter, or build step configured

## Required Environment Variables

`ANTHROPIC_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `ADMIN_PASSWORD` (default: "fbc2024"). Optional location-specific email routing: `EMAIL_JAX`, `EMAIL_JULINGTON`, `EMAIL_STAUGUSTINE`, `EMAIL_DEFAULT`.

## Architecture

Single-file Express backend (`server.js`) serving two static frontends from `public/`.

**server.js** handles everything:
- Security middleware (Helmet, CORS locked to 4 FBC domains, rate limiting 10 req/min on `/api/chat`, origin validation, input validation)
- Claude API integration via raw `https.request` to `api.anthropic.com` (model: claude-sonnet-4-20250514) — not using the Anthropic SDK
- In-memory storage for leads (max 500) and conversations (max 1000) — no database, data resets on restart
- Lead email routing: `getEmailForLocation()` matches location keywords to env vars, CC's kseelig@freedomboatclub.com on all leads
- Conversation analysis: keyword-based sentiment detection and quality flagging (complaint, unanswered, long, negative)
- Weekly summary email via `setInterval` checking for Monday 8am ET
- System prompt (`SYSTEM_PROMPT` variable) contains the full FBC knowledge base with XML-delimited sections

**public/index.html** — chat widget:
- Contains an 82K-character base64-encoded PNG logo on line 91 (makes the file ~75K tokens)
- Parses `[LEAD_CAPTURED]{JSON}` tags from bot responses, strips them from display, and POSTs to `/api/lead`
- Chat history maintained client-side in `chatHistory` array

**public/dashboard.html** — admin panel:
- Password-protected (sessionStorage-based auth via `X-Admin-Password` header)
- Three tabs: Leads (status management, notes), Conversations (flag filtering, message viewer modal), Analytics (Chart.js — hourly, daily, sentiment, flags)
- Auto-refreshes leads every 30 seconds

## Key API Endpoints

Public: `POST /api/chat`, `POST /api/lead`, `GET /health`
Admin (require password): `GET /api/leads`, `POST /api/leads/status`, `GET /api/conversations`, `GET /api/conversations/:id`, `GET /api/analytics`, `POST /api/send-summary`

## Important Patterns

- The system prompt uses XML tags (`<role>`, `<guardrails>`, `<lead_capture>`, `<knowledge_base>`, etc.) for structured Claude parsing
- Lead capture is triggered by Claude including `[LEAD_CAPTURED]{JSON}` at the end of a response — the frontend detects and strips this
- All var declarations (no let/const) — the codebase uses ES5-style JavaScript throughout
- CORS allows no-origin requests (direct access, server-to-server) but blocks unrecognized origins
- The `~1,900` active member count should NOT be included in any prompts or public-facing content

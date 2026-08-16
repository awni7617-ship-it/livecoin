# Forecourt

A stock, enquiry and pricing manager for car dealerships. One `index.html` file —
no build step, no dependencies, no server.

## Deploy to Cloudflare Pages

**Drag and drop (fastest):**

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**
2. Drag the `dealership` folder in (or just `index.html`)
3. Deploy. You get a `*.pages.dev` URL immediately.

**From this repo:**

Connect the repo in Pages and set:

| Setting | Value |
|---|---|
| Build command | *(leave empty)* |
| Build output directory | `dealership` |

## What it does

**Accounts** — email + password. Passwords are hashed with PBKDF2-SHA256
(150,000 iterations) through the browser's WebCrypto API. Each account is one
dealership; its stock is scoped to it.

**Add a car** — type the number plate and the app asks one question at a time.
The registration period is read straight off a UK plate to prefill the year, and
a 17-character VIN can be looked up for free against the NHTSA vPIC database.
The questions adapt: an electric car is asked about its battery and never its
engine size; a car marked "needs work" is asked what needs doing.

**Track everything** — screen price, what you paid, live margin, calls, viewings,
test drives, offers, days in stock, photos, MOT, service history, status
(in stock / prep / reserved / sold).

**Enquiries** — every logged call can become an enquiry with a stage pipeline.
Contacts that have gone quiet for three days or more are flagged.

**Dashboard** — stock value, cash tied up, profit in stock and banked, calls over
the last 30 days against the previous 30, average days in stock, plus a daily
briefing that names the cars needing attention.

**Export** — CSV of stock, and a full JSON backup/restore.

## The AI

Two engines, both free:

**Built-in (default).** Runs in the browser. No key, no account, no cost, works
offline. It handles price advice, listing copy, enquiry replies, the daily
briefing, and questions about your own stock ("which cars had no calls?",
"what should I reprice?", "how much profit have I made?").

**A hosted model (optional).** Settings → AI engine. Works with:

- **Google Gemini** — free tier at [aistudio.google.com](https://aistudio.google.com/apikey), model `gemini-2.0-flash`
- **Groq** or any OpenAI-compatible endpoint (OpenRouter, Together…) — Groq's free tier at [console.groq.com](https://console.groq.com), model `llama-3.3-70b-versatile`

The key is stored in that browser only and sent straight to the provider. Only a
summary of your stock is sent, never customer contact details. If a hosted call
fails for any reason, the built-in engine answers instead, so nothing is ever
dead.

## Where the data lives

`localStorage`, in the browser that created it. That makes the app free to run
and instant to deploy, with two consequences worth knowing:

- Stock does not sync between devices or staff.
- Clearing site data wipes it. **Use Settings → Export backup regularly.**

If you want real multi-device accounts later, the upgrade path is a Cloudflare
Worker plus a D1 database: the storage layer is isolated in the `load`/`save`
functions and the `me()` / `myCars()` / `myEvents()` / `myLeads()` accessors, so
swapping localStorage for API calls does not touch the UI.

## Try it without typing anything

Settings → **Load demo data** puts four cars, their call history and an enquiry
in, so the dashboard and assistant have something to talk about.

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

**Add a car** — type the number plate and the app identifies the car, then asks
only what a lookup cannot tell it: colour and doors, owners and MOT, service
history, condition, equipment, price, photos. Eight steps. A car marked "fair"
or "needs work" gets one extra question about what needs doing.

See **Number plate lookup** below for what "identifies the car" means in
practice — it depends on whether you set up the DVLA key.

**Track everything** — screen price, what you paid, live margin, calls, viewings,
test drives, offers, days in stock, photos, MOT, service history, status
(in stock / prep / reserved / sold).

**Enquiries** — every logged call can become an enquiry with a stage pipeline.
Contacts that have gone quiet for three days or more are flagged.

**Dashboard** — stock value, cash tied up, profit in stock and banked, calls over
the last 30 days against the previous 30, average days in stock, plus a daily
briefing that names the cars needing attention.

**Export** — CSV of stock, and a full JSON backup/restore.

## Number plate lookup

When you type a registration the app tries three sources, best first.

**1. Cars you have had before.** Instant, exact, works offline, nothing to set
up. Enter a plate that has been on your forecourt and everything comes back.

**2. The DVLA.** Free, official, and gives you make, colour, fuel, engine size,
year of manufacture, MOT status and expiry, and tax status. It does **not**
return the model — DVLA simply does not hold it — so the model box stays.

This one needs setting up, because the DVLA key must never sit in a web page and
their API cannot be called from a browser at all. `functions/api/plate.js` in
this folder is a Cloudflare Pages Function that makes the call server-side.
Cloudflare picks it up automatically when you deploy the folder.

1. Get a free key at
   [developer-portal.driver-vehicle-licensing.api.gov.uk](https://developer-portal.driver-vehicle-licensing.api.gov.uk)
2. Pages project → **Settings** → **Variables and secrets** → add a secret named
   `DVLA_API_KEY`
3. Redeploy

Deploying `index.html` on its own is still fine — you just do not get step 2.

**3. The plate itself.** With no lookup configured, the registration is still
decoded offline: the year from the age identifier (`AB12` → March 2012, `AB62` →
September 2012) and the issuing office from the first letter (`L` → London,
`S` → Scotland). Everything else you fill in once, on the same screen.

There is no free service anywhere that turns a UK plate into a full make, model
and trim without a key — the paid providers (UK Vehicle Data, VehicleDataGlobal
and similar) are the only route to the model, and they all charge per lookup. If
you want one of those wired in later, it is a small change to the same function.

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

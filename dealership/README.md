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

**2. Two free government services, merged.** Neither knows enough alone:

| | DVLA | DVSA MOT history |
|---|---|---|
| Make, colour, fuel, engine size | ✅ | ✅ |
| Year of manufacture | ✅ | ✅ |
| **Model** | ❌ never held | ✅ |
| Tax status | ✅ | ❌ |
| MOT status and expiry | ✅ | ✅ |
| **Odometer reading at every MOT** | ❌ | ✅ |
| **Advisories and failures** | ❌ | ✅ |

Together they fill in everything except trim, mileage *today* and condition.
The last MOT odometer reading is used as the opening mileage figure, so usually
you are just correcting it upward.

Both need setting up, because the keys must never sit in a web page and neither
API can be called from a browser at all. `functions/api/plate.js` is a
Cloudflare Pages Function that makes both calls server-side and merges them.
Cloudflare picks it up automatically when you deploy this folder.

**DVLA** — register at
[developer-portal.driver-vehicle-licensing.api.gov.uk](https://developer-portal.driver-vehicle-licensing.api.gov.uk),
then add one secret:

- `DVLA_API_KEY`

**MOT history** — register at
[documentation.history.mot.api.gov.uk](https://documentation.history.mot.api.gov.uk).
They email you three values, which become three secrets:

- `MOT_CLIENT_ID`
- `MOT_CLIENT_SECRET`
- `MOT_API_KEY`

Add them under Pages project → **Settings** → **Variables and secrets**, then
redeploy. Either service works without the other — whatever is configured gets
used. Deploying `index.html` on its own is still fine; you just fall through to
source 3.

Once MOT history is on, each vehicle page grows an **MOT history** panel: the
odometer at every test as a bar chart, the average miles a year calculated from
it, failed tests marked, and the advisories from the most recent test. Those
advisories also feed the price advice and the dashboard briefing — a buyer can
read them online before they ring you, so it is better to know first.

**3. The plate itself.** With no lookup configured, the registration is still
decoded offline: the year from the age identifier (`AB12` → March 2012, `AB62` →
September 2012) and the issuing office from the first letter (`L` → London,
`S` → Scotland). Everything else you fill in once, on the same screen.

What still cannot be looked up anywhere, at any price: **today's mileage** and
**condition**. The trim level (ST-Line, GT, Sport) is only sold commercially, by
providers like UK Vehicle Data and VehicleDataGlobal, at a few pence per lookup —
wiring one in is a small change to the same function if you ever want it.

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

# Forecourt

Stock, enquiry and collection tracking for car dealerships. Type a number plate, the car
identifies itself, and from then on Forecourt keeps the score: who viewed it, who rang, who is
collecting it, how long it has been standing and what it is worth today.

Runs entirely on Cloudflare — a Worker for the API, D1 for the data, static assets for the app.
No servers, no build step, no dependencies at runtime.

---

## Deploy it

```bash
cd forecourt
npm install
npm run setup     # creates the D1 database and writes its id into wrangler.toml
npm run deploy    # publishes to your Cloudflare account
```

`npm run setup` needs you to be signed in to Cloudflare (`npx wrangler login` if you are not).
That is the whole install: the Worker creates its own tables on first request, so there is no
migration step to remember.

To try it locally first:

```bash
npm run dev       # http://localhost:8787, with a local database
```

Sign up with your dealership name and you are in. On an empty account it offers to drop in six
example cars with viewings, calls and a couple of collections booked, so you can see the shape of
it before typing in real stock.

---

## What it does

**Add a car from its plate.** Type the registration into the plate field. Forecourt reads the
plate itself — format, age identifier, the six-month window it was registered in, and the DVLA
office that issued it — then fills in whatever a lookup can add. Everything is editable, and a
plate it cannot place still saves fine with details entered by hand.

**Count every enquiry.** One tap on a vehicle logs a viewing, a phone call, an enquiry, a test
drive or an offer. Add a name and number if you have them, or just count it. Every car then
carries its own tally: viewings, calls, enquiries, days in stock.

**Know who is coming in.** Book viewings, test drives and collections against a car with a
customer name, number and time. Take a deposit on a collection and the car marks itself reserved.
The diary shows the lot, day by day, and each booking can be marked done or a no-show.

**Know what it is worth.** Every car carries a guide value — forecourt retail, private, trade and
part-exchange — worked out from make, model, age, mileage, condition, fuel and service history,
with every adjustment shown so you can argue with it. Save it, or save your own figure over the
top; valuations are kept with a date so you can see how a car has moved.

**See what is going wrong.** Each car gets a plain-English read: fresh stock, hot car, priced
above guide, plenty of looks but no buyer, or stuck stock. The dashboard puts stock value,
average age, weekly interest and monthly margin in front of you, plus your oldest stock and the
cars getting the most attention.

**Work as a team.** One dealership account, a join code for the rest of the team, roles for
owners and members, and a record of who logged what.

Also in there: search across plate, make, model, stock number, colour and VIN; stock aging
buckets and profit reporting; CSV export; light and dark themes; and a layout built for a phone
on the forecourt as much as a desk.

---

## Live plate lookups (optional)

Out of the box, with no keys at all:

- **Plate decoding** — UK current, prefix, suffix, Northern Ireland and dateless formats;
  age identifier to registration window; memory tag to issuing DVLA office.
- **VIN decoding** — the free, keyless NHTSA vPIC database, which is where make, model and trim
  come from when a VIN is known.

For live make, colour, fuel, engine size, CO₂, MOT and tax status straight from the registration,
add a key as a Worker secret:

```bash
npx wrangler secret put DVLA_API_KEY
```

A DVLA Vehicle Enquiry Service key is free from
<https://developer-portal.driver-vehicle-licensing.api.gov.uk/>.

Prefer a provider you already pay for? Point Forecourt at it instead — no code changes:

```bash
npx wrangler secret put LOOKUP_URL      # e.g. https://api.example.com/lookup?reg={plate}
npx wrangler secret put LOOKUP_KEY      # your key
npx wrangler secret put LOOKUP_HEADER   # header name, defaults to x-api-key
```

Provider responses are cached in D1 for 30 days, so the same plate is never paid for twice.

---

## How it is built

```
wrangler.toml        Worker + D1 + static asset configuration
schema.sql           The database, also applied automatically on first request
src/index.js         API: auth, vehicles, activity, diary, valuations, reports
src/lookup.js        Plate decoding, DVLA / generic providers, VIN decoding
src/valuation.js     The guide valuation model and the stock advice
public/index.html    App shell and the sign-in screen
public/app.js        The whole front end — vanilla JS, hash routing, no framework
public/styles.css    Design system, light and dark
scripts/setup.mjs    One-shot database creation
```

**Security.** Passwords are hashed with PBKDF2-SHA256 (100,000 iterations, per-user salt).
Sessions are random 256-bit tokens, stored only as hashes, in an HttpOnly SameSite cookie.
Every query is scoped to the signed-in user's dealership, writes are same-origin only, and all
SQL is parameterised.

**The valuation model** is deterministic and transparent rather than a data feed: it prices from
the make's price band, the model where it recognises one, then applies age, mileage against an
8,000-a-year benchmark, condition, fuel type, MOT and service history. Spot-checked against real
UK retail prices it lands within about 10–15%. It is a guide to argue with, not a trade book —
which is why the app shows its working and lets anyone save their own number instead.

**Data.** Everything lives in your own D1 database in your own Cloudflare account. Nothing is
sent anywhere else except the plate or VIN you look up, and only to the provider you configured.

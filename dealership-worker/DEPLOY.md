# Deploying Forecourt — no GitHub, no drag and drop

Cloudflare's drag-and-drop upload only serves static files; it cannot run the
plate lookup. Connecting a Git repository is the other way Cloudflare offers,
and this is the third: deploying straight from your PC with one command.

You need **Node.js** installed once, from [nodejs.org](https://nodejs.org)
(take the LTS button). Nothing else.

## Deploy

Open a terminal in this folder — on Windows, open the folder in File Explorer,
click the address bar, type `cmd` and press Enter. Then:

```
npx wrangler login
npx wrangler deploy
```

The first command opens your browser to approve access to your own Cloudflare
account. The second puts the site live and prints its address, something like
`https://forecourt.your-name.workers.dev`.

That is the whole deployment. Every later update is just `npx wrangler deploy`
again.

## Switch the plate lookup on

Both services are free and both need you to register. Run each command, paste
the value when prompted, then deploy once more.

**DVLA** — register at
[developer-portal.driver-vehicle-licensing.api.gov.uk](https://developer-portal.driver-vehicle-licensing.api.gov.uk)

```
npx wrangler secret put DVLA_API_KEY
```

**MOT history** — register at
[documentation.history.mot.api.gov.uk](https://documentation.history.mot.api.gov.uk).
They email a client ID, a client secret and an API key.

```
npx wrangler secret put MOT_CLIENT_ID
npx wrangler secret put MOT_CLIENT_SECRET
npx wrangler secret put MOT_API_KEY
npx wrangler deploy
```

Secrets are stored encrypted at Cloudflare. They never go in a file, and they
never reach the browser.

## Check it worked

Open the site, then **Settings → Number plate lookup**:

- **Lookup is working** — done. Type a registration and it fills itself in.
- **Lookup is deployed but has no keys** — deployment is fine, add the secrets.
- **Running as a single file** — the Worker did not deploy; you are looking at
  a plain copy of `index.html`.

Approval from DVLA can take a day or two, so the middle message is the normal
first result. Everything else in the app works meanwhile.

## Changing the address

The name in `wrangler.toml` becomes the subdomain. Change `name = "forecourt"`
to whatever you want and deploy again. A custom domain can be attached later in
the Cloudflare dashboard under the Worker's **Settings → Domains & Routes**.

## What is in here

```
wrangler.toml      deployment settings
public/index.html  the whole app
src/worker.js      routes /api/plate to the lookup, everything else to the app
src/plate.js       the DVLA and MOT history lookup
```

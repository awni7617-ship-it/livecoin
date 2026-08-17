/*
  Number plate lookup — shared by the Worker entry point in worker.js.

  Answers /api/plate. It calls two free government services and merges them,
  because neither one alone knows enough:

    DVLA Vehicle Enquiry Service   make, colour, fuel, engine size, year,
                                   MOT status, tax status
    DVSA MOT History               model, every past MOT with its odometer
                                   reading, and the advisories from each test

  Both need keys, and both must be called from a server — neither sends CORS
  headers, and the keys must never reach the browser. Either can be configured
  without the other; whatever is missing is simply left out of the response.

  Keys are set from the command line, one at a time. Each command asks you to
  paste the value, and it is stored encrypted at Cloudflare — never in a file:

    DVLA — register at https://developer-portal.driver-vehicle-licensing.api.gov.uk
      npx wrangler secret put DVLA_API_KEY

    MOT history — register at https://documentation.history.mot.api.gov.uk
      npx wrangler secret put MOT_CLIENT_ID
      npx wrangler secret put MOT_CLIENT_SECRET
      npx wrangler secret put MOT_API_KEY

  (MOT_TENANT_ID too, only if DVSA gave you a tenant other than the default.)

  With neither configured the endpoint answers 501 and the app falls back to
  reading the registration period off the plate itself.
*/

const DVLA_URL = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
const MOT_URL = 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/';
const MOT_SCOPE = 'https://tapi.dvsa.gov.uk/.default';
const MOT_TENANT = 'a455b827-244f-4c97-b5b4-ce5d13b4d00c';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

const title = (s) => (s ? String(s).charAt(0) + String(s).slice(1).toLowerCase() : '');

/* DVSA uses OAuth client credentials. Tokens last an hour, so hold on to one
   for as long as the isolate lives rather than minting one per lookup. */
let cachedToken = null;

async function motToken(env) {
  if (cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.value;
  const tenant = env.MOT_TENANT_ID || MOT_TENANT;
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.MOT_CLIENT_ID,
      client_secret: env.MOT_CLIENT_SECRET,
      scope: MOT_SCOPE,
    }),
  });
  if (!res.ok) throw new Error('mot_auth_failed');
  const j = await res.json();
  cachedToken = { value: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function fetchDvla(env, reg) {
  const res = await fetch(DVLA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.DVLA_API_KEY },
    body: JSON.stringify({ registrationNumber: reg }),
  });
  if (!res.ok) return null;
  const v = await res.json();
  return {
    make: title(v.make),
    colour: title(v.colour),
    fuel: title(v.fuelType),
    engine: v.engineCapacity || null,
    year: v.yearOfManufacture || null,
    motStatus: v.motStatus || '',
    motExpiry: v.motExpiryDate || '',
    taxStatus: v.taxStatus || '',
    co2: v.co2Emissions ?? null,
  };
}

async function fetchMot(env, reg) {
  const token = await motToken(env);
  const res = await fetch(MOT_URL + encodeURIComponent(reg), {
    headers: {
      authorization: 'Bearer ' + token,
      'x-api-key': env.MOT_API_KEY,
      accept: 'application/json+v6',
    },
  });
  if (!res.ok) return null;
  const v = await res.json();

  const tests = (v.motTests || [])
    .map(t => ({
      date: t.completedDate || '',
      result: t.testResult || '',
      expiry: t.expiryDate || '',
      odometer: Number(t.odometerValue) || null,
      unit: t.odometerUnit || 'mi',
      advisories: (t.defects || [])
        .filter(d => /advisory|minor/i.test(d.type || ''))
        .map(d => d.text),
      failures: (t.defects || [])
        .filter(d => /fail|major|dangerous/i.test(d.type || ''))
        .map(d => d.text),
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return {
    make: title(v.make),
    model: title(v.model),
    fuel: title(v.fuelType),
    colour: title(v.primaryColour),
    engine: Number(v.engineSize) || null,
    firstUsedDate: v.firstUsedDate || v.registrationDate || '',
    motTests: tests,
  };
}

export async function handlePlate(request, env) {
  const url = new URL(request.url);
  const hasDvla = Boolean(env.DVLA_API_KEY);
  const hasMot = Boolean(env.MOT_CLIENT_ID && env.MOT_CLIENT_SECRET && env.MOT_API_KEY);

  /* ?status=1 answers "is lookup working?" without spending a lookup. A 404
     here means this function was never deployed at all, which is a different
     problem from a missing key and needs different advice. */
  if (url.searchParams.get('status')) {
    return json({ ok: true, dvla: hasDvla, mot: hasMot });
  }

  const reg = (url.searchParams.get('reg') || '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!/^[A-Z0-9]{2,8}$/.test(reg)) return json({ error: 'bad_registration' }, 400);
  if (!hasDvla && !hasMot) return json({ error: 'not_configured' }, 501);

  // One slow service should not hold up the other.
  const [dvla, mot] = await Promise.all([
    hasDvla ? fetchDvla(env, reg).catch(() => null) : null,
    hasMot ? fetchMot(env, reg).catch(() => null) : null,
  ]);

  if (!dvla && !mot) return json({ error: 'not_found' }, 404);

  const latest = mot?.motTests?.find(t => t.odometer);
  const sources = [dvla && 'dvla', mot && 'mot'].filter(Boolean);

  // DVLA wins on the fields it is authoritative for; MOT history supplies the
  // model and the odometer, which DVLA does not hold at all.
  return json({
    registration: reg,
    sources,
    make: dvla?.make || mot?.make || '',
    model: mot?.model || '',
    colour: dvla?.colour || mot?.colour || '',
    fuel: dvla?.fuel || mot?.fuel || '',
    engine: dvla?.engine || mot?.engine || null,
    year: dvla?.year || (mot?.firstUsedDate || '').slice(0, 4) || null,
    motStatus: dvla?.motStatus || '',
    motExpiry: dvla?.motExpiry || mot?.motTests?.[0]?.expiry || '',
    taxStatus: dvla?.taxStatus || '',
    co2: dvla?.co2 ?? null,
    lastOdometer: latest?.odometer || null,
    lastOdometerDate: latest?.date || '',
    motTests: mot?.motTests || [],
  });
}

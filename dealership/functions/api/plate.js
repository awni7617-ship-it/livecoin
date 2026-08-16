/*
  Cloudflare Pages Function — number plate lookup.

  The DVLA Vehicle Enquiry Service is free, but the key must never sit in the
  browser and the API sends no CORS headers, so the call has to be made from a
  server. This function is that server: Cloudflare runs it automatically for any
  request to /api/plate, right alongside the static index.html.

  Setup (once):
    1. Register for a free key at https://developer-portal.driver-vehicle-licensing.api.gov.uk
    2. Pages project → Settings → Variables and secrets → add a secret
       named DVLA_API_KEY
    3. Redeploy

  Until that is done the endpoint returns 501 and the app falls back to reading
  the registration period straight off the plate.
*/

const DVLA_URL = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export async function onRequestGet({ request, env }) {
  const reg = (new URL(request.url).searchParams.get('reg') || '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!/^[A-Z0-9]{2,8}$/.test(reg)) return json({ error: 'bad_registration' }, 400);
  if (!env.DVLA_API_KEY) return json({ error: 'not_configured' }, 501);

  const res = await fetch(DVLA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.DVLA_API_KEY },
    body: JSON.stringify({ registrationNumber: reg }),
  });

  if (res.status === 404) return json({ error: 'not_found' }, 404);
  if (!res.ok) return json({ error: 'lookup_failed', status: res.status }, 502);

  const v = await res.json();

  // Only the fields the app uses — nothing else leaves this function.
  return json({
    registrationNumber: v.registrationNumber,
    make: v.make,
    colour: v.colour,
    fuelType: v.fuelType,
    engineCapacity: v.engineCapacity,
    yearOfManufacture: v.yearOfManufacture,
    monthOfFirstRegistration: v.monthOfFirstRegistration,
    motStatus: v.motStatus,
    motExpiryDate: v.motExpiryDate,
    taxStatus: v.taxStatus,
    taxDueDate: v.taxDueDate,
    wheelplan: v.wheelplan,
    co2Emissions: v.co2Emissions,
  });
}

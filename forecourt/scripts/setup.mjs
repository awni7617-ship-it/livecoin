#!/usr/bin/env node
/**
 * One-shot setup: create the D1 database, write its id into wrangler.toml and
 * apply the schema. Safe to run more than once.
 *
 *   npm run setup
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'wrangler.toml');
const DB_NAME = 'forecourt';

const say = (msg) => process.stdout.write(`${msg}\n`);

function wrangler(args, { quiet = false } = {}) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'pipe', 'inherit'],
  });
}

function findExistingId() {
  try {
    const out = wrangler(['d1', 'list', '--json'], { quiet: true });
    const list = JSON.parse(out.slice(out.indexOf('[')));
    const match = list.find((db) => db.name === DB_NAME);
    return match ? match.uuid || match.database_id : null;
  } catch {
    return null;
  }
}

say('\n  Forecourt setup\n  ───────────────\n');

let config = readFileSync(configPath, 'utf8');
const current = config.match(/database_id\s*=\s*"([^"]+)"/);
let databaseId = current && !current[1].startsWith('REPLACE_') ? current[1] : null;

if (databaseId) {
  say(`  ✓ wrangler.toml already points at database ${databaseId}`);
} else {
  say('  • Creating the D1 database…');
  let created = '';
  try {
    created = wrangler(['d1', 'create', DB_NAME], { quiet: true });
  } catch (err) {
    created = `${err.stdout || ''}${err.stderr || ''}`;
    if (!/already exists/i.test(created)) {
      say('\n  Could not create the database. Are you signed in? Try `npx wrangler login`.\n');
      say(created.trim());
      process.exit(1);
    }
    say('  • A database called "forecourt" already exists — reusing it.');
  }

  const match = created.match(/database_id\s*=\s*"([^"]+)"/)
    || created.match(/"database_id":\s*"([^"]+)"/)
    || created.match(/\buuid\W+([0-9a-f-]{36})/i);
  databaseId = (match && match[1]) || findExistingId();

  if (!databaseId) {
    say('\n  The database was created but its id could not be read automatically.');
    say('  Run `npx wrangler d1 list`, copy the id and paste it into wrangler.toml.\n');
    process.exit(1);
  }

  config = config.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${databaseId}"`);
  writeFileSync(configPath, config);
  say(`  ✓ Database ready — id written into wrangler.toml (${databaseId})`);
}

say('  • Applying the schema…');
try {
  wrangler(['d1', 'execute', DB_NAME, '--remote', '--file=./schema.sql', '-y'], { quiet: true });
  say('  ✓ Schema applied');
} catch (err) {
  const out = `${err.stdout || ''}${err.stderr || ''}`;
  say('  ! Schema step did not finish cleanly. The Worker creates its own tables on first');
  say('    request, so this is usually fine. Details:');
  say(`    ${out.trim().split('\n').slice(-3).join('\n    ')}`);
}

say('\n  Done. Next:\n');
say('    npm run dev      # try it locally at http://localhost:8787');
say('    npm run deploy   # publish it to your Cloudflare account\n');
say('  Optional, for live plate data:');
say('    npx wrangler secret put DVLA_API_KEY\n');

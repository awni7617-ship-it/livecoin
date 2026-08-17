#!/bin/bash
# macOS: double-click this file. If it will not open, right-click -> Open.
cd "$(dirname "$0")" || exit 1

echo "============================================"
echo "  Forecourt - putting your site live"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed yet."
  echo "  1. Go to https://nodejs.org"
  echo "  2. Click the big LTS button and install it"
  echo "  3. Run this file again"
  read -r -p "Press Enter to close."
  exit 1
fi

npx --yes wrangler login || { read -r -p "Login failed. Press Enter."; exit 1; }
npx --yes wrangler deploy || { read -r -p "Deploy failed. Press Enter."; exit 1; }

echo
echo "Done - your address is printed above, ending in .workers.dev"
read -r -p "Press Enter to close."

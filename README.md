# Notepad (Standalone)

This is the extracted Notepad web app, split from the MMO frontend project.

## Run locally

1. `cp .env.example .env`
2. `npm install`
3. `npm run dev`

## Build

- `npm run build`

## Deploy (Cloudflare Pages)

1. Set secrets in `../.env.local` or your shell:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_PAGES_PROJECT_NAME_NOTEPAD`
2. Run: `./scripts/deploy-cloudflare-pages.sh`

## Backend target

Notepad uses:
- `VITE_NOTEPAD_SPACE_TIME_ENDPOINT`
- `VITE_NOTEPAD_SPACE_TIME_SCHEMA`

This allows Notepad to target its own SpacetimeDB schema/instance independently from MMO.

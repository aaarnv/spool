# spool-web

The hosted watch app + dashboard (Next.js, Clerk, Neon, Vercel Blob) behind
https://spoolkit.dev — watch pages (`/l/<id>`), per-user publish tokens, and the
hosted voiceover endpoint (`/api/vo`).

Deploys automatically: pushes to `master` that touch `web/` build via Vercel
(root directory `web/`); pushes that don't touch `web/` are skipped.

## Billing

Free publishes up to 3 spools per owner (lifetime); Pro ($8/mo) is unlimited.
The gate lives in `api/publish` and fires only when publishing a 4th spool.
Published links never expire regardless of plan. Self-hosting stays free.

Stripe is called via raw fetch (no SDK); see `lib/billing.ts`. Set
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_ID` (the $8/mo
recurring price). Missing env makes the billing routes 503; the publish gate
still counts spools but `isPro` returns false without a paid `billing` row.
Point a Stripe webhook at `/api/billing/webhook` for
`checkout.session.completed` and `customer.subscription.*`.

# spool-web

The hosted watch app + dashboard (Next.js, Clerk, Neon, Vercel Blob) behind
https://spoolkit.dev — watch pages (`/l/<id>`), per-user publish tokens, and the
hosted voiceover endpoint (`/api/vo`).

Deploys automatically: pushes to `master` that touch `web/` build via Vercel
(root directory `web/`); pushes that don't touch `web/` are skipped.

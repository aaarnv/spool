# Spool landing page — design brief (from Aarnav, 2026-07-08)

Reference layout: `docs/landing-reference.png` (Verdant SEO tool). Follow its structure,
not its content or palette. Background style: https://shaders.paper.design/ — use
`@paper-design/shaders-react` (verified on npm, v0.0.77+; `MeshGradient`, `DotOrbit`).

## Structure (top to bottom, per the reference)

1. **Floating pill nav**, top-center: Spool logo/wordmark left; links (Features,
   Open source, Pricing, Docs); rounded white/translucent pill with soft shadow.
2. **Animated shader background** filling the viewport — Paper MeshGradient. Palette:
   echo the Sonoma-wallpaper tones Spool videos use (blues/coral/green) so the site and
   the product's videos read as one brand. Subtle motion, never distracting.
3. **Hero headline**: huge, two lines, mixed typography — plain grotesk words with 1–2
   inline highlighted word-chips (rounded tinted boxes, small icon + italic serif word,
   like "Content" / "Organic traffic" in the reference). Spool copy direction:
   "Turn [agent work] into [client-ready walkthroughs]" or
   "Your agents [record] their own [demos]". Punchy; no jargon.
4. **Subhead**: 1–2 lines. Angle: agents record, narrate, and publish walkthroughs of
   the work they ship — no human ever hits record. One link to watch, for humans and
   agents.
5. **Single large CTA** (rounded, high-contrast): e.g. "Publish your first spool" +
   secondary "Star on GitHub" ghost link.
6. **Product shot rising from the bottom of the hero** (like the reference's dashboard):
   for Spool this is the WATCH PAGE with a real published spool (or the dashboard once
   it exists) — real screenshot, slightly cropped by the fold, rounded corners, shadow.
   Ideally the hero artifact is a real playing spool (muted autoplay video embed).

## Rules

- This is the marketing face of an open-source + paid-hosted product; it must look
  designed, not templated. Load the frontend-design skill before building.
- Real assets only: screenshot the live watch page, embed the real finishing-lab spool.
- Brand name is **Spool** everywhere (rename from agent-loom happens before this builds).
- Keep Lighthouse sane: the shader is the only heavy element; everything else is light.

// Mockup specs in, screenshots of the product out.
//
// A design plan is judged on what the screens LOOK like, so its video shows screens
// rather than mechanism diagrams. The author writes a small block DSL and this file
// owns the pixels: the stylesheet below is the feed's own visual language
// (web/app/feed/queue.css and web/app/globals.css), so a mockup reads as the app
// instead of as a wireframe, and the same spec always renders the same PNG.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Phone proportions, and the numbers the readability gate measures against: a
// mockup is composited MOCK_FIT_W frame-pixels wide at the comp's 2x scale, so a
// CSS pixel here lands as `MOCK_FIT_W * 2 / MOCK_W` pixels in the 1080-wide frame.
export const MOCK_W = 400, MOCK_H = 680, MOCK_DSF = 2;
export const MOCK_FIT_W = 341;
export const DEVICE_PX_PER_CSS_PX = (MOCK_FIT_W * 2) / MOCK_W;

export const BLOCKS = new Set(['eyebrow', 'heading', 'text', 'chips', 'rows', 'cards', 'stats', 'note', 'button', 'lanes', 'sheet', 'nav']);
// A block pinned to the bottom of the screen; at most one, and it goes last.
export const PINNED = new Set(['sheet', 'nav']);
// A block that absorbs the screen's leftover height. A screen with none of these
// spreads its blocks out instead, so short copy never leaves one hole at the bottom.
const GROWS = new Set(['rows', 'cards', 'lanes']);

// The smallest type any block uses, in CSS px — the readability gate reads this
// table rather than guessing, because this file is the only thing that sets sizes.
export const MIN_TYPE = 11;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TONES = { go: 'var(--accent)', ok: 'var(--ok)', back: 'var(--warn)', warn: 'var(--warn)', stop: 'var(--danger)', danger: 'var(--danger)', hold: 'rgba(255,255,255,.14)', idle: 'var(--faint)' };
const tone = (t) => TONES[t] || 'var(--accent)';

// Straight from the feed's tokens. Depth is shadows and inset rings only: the app
// draws no flat 1px borders, and no card carries a coloured edge stripe.
const CSS = `
:root{
  --bg:#0a0a0b; --panel:#141416; --panel-2:#1b1b1e;
  --text:#ededf0; --muted:#9a9aa3; --faint:#6b6b73;
  --accent:#6d5efc; --accent-soft:rgba(109,94,252,.14);
  --ok:#3ecf8e; --warn:#e5a13a; --danger:#e5484d;
  --glass:rgba(12,11,18,.55); --sheet:rgba(17,16,24,.94);
  --edge:0 1px 2px rgba(0,0,0,.35);
  --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${MOCK_W}px;height:${MOCK_H}px;overflow:hidden}
body{
  background:radial-gradient(120% 80% at 50% -10%,#12111c 0%,var(--bg) 60%);
  color:var(--text); font-family:var(--font); -webkit-font-smoothing:antialiased;
}
.screen{display:flex;flex-direction:column;height:${MOCK_H}px;position:relative}
.top{display:flex;align-items:center;gap:8px;padding:16px 18px 12px}
.top h1{font-size:15px;font-weight:650;letter-spacing:-.015em}
.top .count{
  margin-left:auto;font-size:11.5px;font-weight:550;color:var(--muted);
  font-variant-numeric:tabular-nums;background:var(--glass);box-shadow:var(--edge);
  border-radius:999px;padding:5px 10px;
}
.body{flex:1;min-height:0;overflow:hidden;padding:0 18px 18px;display:flex;flex-direction:column;gap:12px}
/* Nothing on this screen can grow, so the slack becomes even spacing rather
   than one hole at the bottom. */
.body.spread{justify-content:space-between}
.eyebrow{font-size:10.5px;font-weight:650;letter-spacing:.13em;text-transform:uppercase;color:var(--faint)}
.heading{font-size:20px;font-weight:620;letter-spacing:-.026em;line-height:1.22}
.text{font-size:13.5px;line-height:1.5;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:7px}
.chip{
  font-size:13px;font-weight:600;letter-spacing:-.01em;border-radius:999px;padding:7px 13px;
  background:var(--glass);color:var(--muted);box-shadow:var(--edge);
}
.chip.on{background:rgba(109,94,252,.92);color:#fff;box-shadow:0 8px 22px -12px rgba(109,94,252,.9),var(--edge)}
.rows{display:flex;flex-direction:column;gap:7px;flex:1 1 auto}
.row{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.045);border-radius:14px;padding:11px 13px;box-shadow:var(--edge);flex:1 1 auto;min-height:56px;max-height:104px}
.row .dot{width:8px;height:8px;border-radius:999px;flex:none}
.row .rt{flex:1;min-width:0}
.row .rtitle{display:block;font-size:14px;font-weight:620;letter-spacing:-.012em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .rmeta{display:block;font-size:11.5px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .rright{font-size:11px;font-weight:650;letter-spacing:.02em;color:var(--faint);font-variant-numeric:tabular-nums;flex:none}
.cards{display:grid;gap:8px;flex:1 1 auto;align-content:stretch}
.card{display:flex;flex-direction:column;justify-content:center;align-items:flex-start;background:rgba(255,255,255,.045);border-radius:14px;padding:12px 13px;box-shadow:var(--edge)}
.card.sel{background:rgba(109,94,252,.16);box-shadow:inset 0 0 0 1.5px rgba(109,94,252,.7),var(--edge)}
.card .ctitle{font-size:14px;font-weight:620;letter-spacing:-.015em}
.card .cbody{font-size:12px;line-height:1.45;color:var(--muted);margin-top:5px}
.tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#b9b0ff;background:rgba(109,94,252,.22);border-radius:999px;padding:3px 8px;margin-bottom:7px}
.stats{display:flex;gap:8px}
.stat{flex:1;background:rgba(255,255,255,.045);border-radius:14px;padding:11px 12px;box-shadow:var(--edge)}
.stat .v{font-size:22px;font-weight:650;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.stat .l{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);margin-top:4px}
.note{display:flex;gap:9px;align-items:flex-start;background:rgba(255,255,255,.05);border-radius:14px;padding:11px 13px;box-shadow:var(--edge)}
.note .dot{width:8px;height:8px;border-radius:999px;margin-top:4px;flex:none}
.note .nt{font-size:12.5px;line-height:1.45;color:var(--muted)}
.btn{
  display:block;width:100%;text-align:center;border-radius:14px;padding:13px 16px;
  font-size:15px;font-weight:620;letter-spacing:-.01em;color:#fff;
  background:var(--accent);box-shadow:0 12px 30px -14px rgba(109,94,252,.95);
}
.btn.back{background:var(--warn);color:#1a1206}
.btn.stop{background:var(--danger)}
.btn.hold{background:rgba(255,255,255,.14);color:var(--text);box-shadow:var(--edge)}
.lanes{display:flex;flex-direction:column;gap:8px;flex:1 1 auto}
.lane{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.045);border-radius:14px;padding:0 13px;box-shadow:var(--edge);flex:1 1 auto;max-height:88px;min-height:44px}
.lane .ll{width:88px;flex:none;font-size:11.5px;font-weight:600;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lane .track{position:relative;flex:1;height:16px;background:rgba(255,255,255,.045);border-radius:999px}
.lane .span{position:absolute;top:0;height:16px;border-radius:999px}
.sheet{
  flex:none;background:var(--sheet);
  border-radius:22px 22px 0 0;padding:12px 18px 20px;box-shadow:0 -20px 60px -20px rgba(0,0,0,.9);
}
.grab{width:38px;height:4px;border-radius:999px;background:rgba(255,255,255,.22);margin:0 auto 12px}
.sheet h2{font-size:16.5px;font-weight:620;letter-spacing:-.02em;line-height:1.32;margin-bottom:10px}
.opt{background:rgba(255,255,255,.045);border-radius:14px;padding:11px 13px;box-shadow:var(--edge)}
.opt + .opt{margin-top:7px}
.opt.sel{background:rgba(109,94,252,.16);box-shadow:inset 0 0 0 1.5px rgba(109,94,252,.7),var(--edge)}
.opt .olabel{font-size:15px;font-weight:620;letter-spacing:-.015em}
.opt .osum{font-size:12.5px;line-height:1.45;color:var(--muted);margin-top:4px}
.nav{flex:none;display:flex;gap:6px;padding:12px 18px 20px}
.nav .n{flex:1;text-align:center;font-size:11.5px;font-weight:600;color:var(--faint);background:var(--glass);border-radius:999px;padding:9px 6px;box-shadow:var(--edge)}
.nav .n.on{color:#fff;background:rgba(109,94,252,.92);box-shadow:0 8px 22px -12px rgba(109,94,252,.9),var(--edge)}
`;

function block(b) {
  switch (b.type) {
    case 'eyebrow': return `<div class="eyebrow">${esc(b.text)}</div>`;
    case 'heading': return `<div class="heading">${esc(b.text)}</div>`;
    case 'text': return `<div class="text">${esc(b.text)}</div>`;
    case 'chips':
      return `<div class="chips">${(b.items || []).map((c) => `<span class="chip${c.on ? ' on' : ''}">${esc(c.text ?? c)}</span>`).join('')}</div>`;
    case 'rows':
      return `<div class="rows">${(b.items || []).map((r) => `<div class="row">`
        + `<span class="dot" style="background:${tone(r.state || 'idle')}"></span>`
        + `<span class="rt"><span class="rtitle">${esc(r.title)}</span>${r.meta ? `<span class="rmeta">${esc(r.meta)}</span>` : ''}</span>`
        + `${r.right ? `<span class="rright">${esc(r.right)}</span>` : ''}</div>`).join('')}</div>`;
    case 'cards':
      return `<div class="cards" style="grid-template-columns:repeat(${b.columns === 2 ? 2 : 1},1fr)">`
        + (b.items || []).map((c) => `<div class="card${c.selected ? ' sel' : ''}">`
          + `${c.tag ? `<span class="tag">${esc(c.tag)}</span>` : ''}`
          + `<div class="ctitle">${esc(c.title)}</div>${c.body ? `<div class="cbody">${esc(c.body)}</div>` : ''}</div>`).join('')
        + `</div>`;
    case 'stats':
      return `<div class="stats">${(b.items || []).map((s) => `<div class="stat"><div class="v">${esc(s.value)}</div><div class="l">${esc(s.label)}</div></div>`).join('')}</div>`;
    case 'note':
      return `<div class="note"><span class="dot" style="background:${tone(b.tone || 'warn')}"></span><span class="nt">${esc(b.text)}</span></div>`;
    case 'button':
      return `<div class="btn ${esc(b.tone || 'go')}">${esc(b.text)}</div>`;
    case 'lanes':
      return `<div class="lanes">${(b.items || []).map((l) => `<div class="lane"><span class="ll">${esc(l.label)}</span><span class="track">`
        + (l.spans || []).map((s) => {
          const from = Math.max(0, Math.min(100, Number(s.from) || 0));
          const to = Math.max(from + 2, Math.min(100, Number(s.to) || 0));
          return `<span class="span" style="left:${from}%;width:${to - from}%;background:${tone(s.state || 'go')}"></span>`;
        }).join('')
        + `</span></div>`).join('')}</div>`;
    case 'sheet':
      return `<div class="sheet"><div class="grab"></div><h2>${esc(b.title)}</h2>`
        + (b.options || []).map((o) => `<div class="opt${o.selected ? ' sel' : ''}"><div class="olabel">${esc(o.label)}</div>`
          + `${o.summary ? `<div class="osum">${esc(o.summary)}</div>` : ''}</div>`).join('')
        + `</div>`;
    case 'nav':
      return `<div class="nav">${(b.items || []).map((n, i) => `<span class="n${i === (b.active ?? 0) ? ' on' : ''}">${esc(n)}</span>`).join('')}</div>`;
    default: return '';
  }
}

// Squeeze levels. A screen that misses by 12px is a spacing problem, not a content
// problem, and asking the model to redraw it burns a retry on arithmetic it cannot
// do. So the layout tightens itself first, exactly as repairDiagrams nudges a shape
// back on canvas, and only a screen that still will not fit becomes a finding.
const TIGHTEN = [
  '',
  '.body{gap:8px}.row{min-height:48px}.lane{min-height:40px}.btn{padding:11px 16px}.note{padding:9px 13px}',
  '.body{gap:6px}.row{min-height:42px}.lane{min-height:36px}.btn{padding:9px 16px}.note{padding:8px 12px}'
    + '.card{padding:10px 11px}.opt{padding:9px 12px}.sheet{padding:10px 16px 14px}',
  '.body{gap:5px;padding-bottom:10px}.row{min-height:38px}.lane{min-height:32px}.btn{padding:8px 16px}'
    + '.note{padding:7px 12px}.card{padding:9px 11px}.opt{padding:8px 12px}.opt+.opt{margin-top:5px}'
    + '.sheet{padding:8px 16px 10px}.sheet h2{margin-bottom:7px}.grab{margin-bottom:8px}',
];

/** One mockup spec rendered to a standalone HTML document. */
export function mockupHtml(m, tighten = 0) {
  const blocks = (m.blocks || []).filter((b) => BLOCKS.has(b?.type));
  const flow = blocks.filter((b) => !PINNED.has(b.type));
  const pinned = blocks.filter((b) => PINNED.has(b.type));
  const spread = flow.some((b) => GROWS.has(b.type)) ? '' : ' spread';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}${TIGHTEN[tighten] || ''}</style></head><body>`
    + `<div class="screen"><div class="top"><h1>${esc(m.title)}</h1>`
    + `${m.count ? `<span class="count">${esc(m.count)}</span>` : ''}</div>`
    + `<div class="body${spread}">${flow.map(block).join('')}</div>`
    + `${pinned.map(block).join('')}</div></body></html>`;
}

/**
 * Render every spec to `<dir>/<beat>.html` and shoot each one.
 *
 * Returns one record per mockup with the PNG path and the two facts the gate needs
 * that only the browser knows: whether the content overflowed the screen, and how
 * much of the frame is not background. A blank or clipped screen is a failed beat,
 * not a merely ugly one, so it is measured here rather than eyeballed later.
 */
export async function shootMockups(spec, dir) {
  const { chromium } = await import('playwright');
  await mkdir(dir, { recursive: true });
  const entries = spec.filter((e) => e?.mockup);
  if (!entries.length) return [];

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: MOCK_W, height: MOCK_H }, deviceScaleFactor: MOCK_DSF });
    const out = [];
    for (const e of entries) {
      const slug = String(e.beat).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const html = join(dir, `${slug}.html`), png = join(dir, `${slug}.png`);
      // Tighten until it fits, and keep the loosest version that did.
      let tighten = 0;
      for (; tighten < TIGHTEN.length; tighten++) {
        await writeFile(html, mockupHtml(e.mockup, tighten));
        await page.goto(`file://${html}`);
        const over = await page.evaluate(() => {
          const b = document.querySelector('.body');
          return Math.max(0, b.scrollHeight - b.clientHeight);
        });
        if (!over) break;
      }
      if (tighten === TIGHTEN.length) {
        tighten -= 1;
        await writeFile(html, mockupHtml(e.mockup, tighten));
        await page.goto(`file://${html}`);
      }
      // Ask the browser what actually fit rather than capping characters by guess:
      // ellipsised text is text the viewer cannot read, whatever the spec intended.
      const measured = await page.evaluate(() => {
        const b = document.querySelector('.body');
        const leaves = [...document.querySelectorAll('.body *, .sheet *, .nav *')].filter((n) => !n.children.length && n.textContent.trim());
        // The biggest band of nothing on the screen. A half-drawn mockup reads as a
        // hole on video whether the hole is under the content or in the middle of it,
        // and the stretched list wrappers make "where does the ink stop" the wrong
        // question, so measure the empty runs between the visible bands instead.
        const BANDS = '.eyebrow,.heading,.text,.chips,.row,.card,.stat,.note,.btn,.lane,.sheet,.nav,.top';
        const bands = [...document.querySelectorAll(BANDS)]
          .map((n) => n.getBoundingClientRect()).filter((r) => r.height > 0)
          .sort((x, y) => x.top - y.top);
        let hole = 0, edge = 0;
        for (const r of bands) {
          hole = Math.max(hole, r.top - edge);
          edge = Math.max(edge, r.bottom);
        }
        hole = Math.round(Math.max(hole, window.innerHeight - edge));

        // Two bands sitting on top of each other. A flex child that will not shrink
        // paints over its neighbour rather than making the page taller, so the height
        // check above cannot see it, and it is the one defect a viewer notices first.
        let collide = 0;
        const flow = [...b.children].map((n) => n.getBoundingClientRect());
        for (let i = 1; i < flow.length; i++) collide = Math.max(collide, flow[i - 1].bottom - flow[i].top);
        for (const n of b.querySelectorAll('.rows, .cards, .lanes')) {
          const r = n.getBoundingClientRect();
          const kids = [...n.children].map((c) => c.getBoundingClientRect());
          for (const c of kids) collide = Math.max(collide, c.bottom - r.bottom);
        }
        return {
          overflow: Math.max(0, b.scrollHeight - b.clientHeight),
          texts: leaves.length,
          clipped: leaves.filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent.trim()),
          hole,
          collide: Math.round(Math.max(0, collide)),
        };
      });
      await page.screenshot({ path: png });
      out.push({
        beat: e.beat,
        variant: e.mockup.variant ?? null,
        // The block sequence is how the distinctness gate tells "a different screen"
        // from "the same screen with new words".
        blocks: (e.mockup.blocks || []).map((b) => b?.type).join('>'),
        html, png, tighten, ...measured, ink: await inkRatio(page),
      });
    }
    return out;
  } finally {
    await browser.close();
  }
}

// How much of the screen is not the page background. A mockup that renders blank or
// half-drawn lands near zero here, which no amount of reading the spec would catch.
async function inkRatio(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.body > *, .sheet, .nav, .top')];
    const area = nodes.reduce((a, n) => a + n.getBoundingClientRect().height * n.getBoundingClientRect().width, 0);
    return +(area / (window.innerWidth * window.innerHeight)).toFixed(3);
  });
}

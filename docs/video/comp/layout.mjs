// Shared diagram-label layout for both comp engines (auto.html and skia/scene-auto.mjs).
// The diagrammer places labels blind to glyph widths, so raw coordinates give text
// that runs off the canvas, overprints, straddles a panel border, or misses its
// panel's centre by a few pixels and reads as sloppy. Labels are therefore not
// drawn where the spec says: each one is measured, then takes the first DESIGNED
// SLOT on its own shape that is actually valid — centred on that shape, inside the
// safe area, clear of every other panel, clear of every label already placed.
// Both engines draw the identical resolved list above every shape.
// The authoring canvas is SQUARE, and diaglint.mjs holds the same numbers. A 480x260
// spec is 1.85 wide, so a vertical frame fits it on width and the diagram never grew
// past a quarter of the frame height however much band it was given.
export const DIAG_W = 480, DIAG_H = 480;

const SAFE = 14;       // margin every glyph stays inside
const PAD = 8;         // optical gap between a panel edge and a glyph outside it
const PAD_IN = 10;     // same, for a label sitting inside a panel
const GAP = 5;         // minimum clearance between two label boxes
const SLOP = 4;        // horizontal slack before two labels count as touching
const ROW_EPS = 14;    // panel tops this close count as the same row
const SNAP_EPS = 20;   // a free label this close to a centre line snaps onto it
const ATTACH = 26;     // how far above or below a panel a label still belongs to it
const HUG = 10;        // a label further beside a panel than this is annotating something else
const LEADER_MIN = 30; // displacement past which a label grows a leader line
const MIN_SIZE = 13;   // font floor when a label is shrunk to fit
// A badge is the box's CONTENT: it belongs inside the box it names, and a badge that
// does not fit is a layout problem, not a reason to redraw the diagram. It shrinks to
// this fraction of its authored size, then loses characters from its MIDDLE, which is
// where an identifier carries the least: SPOOL_DIAGRAM_LOOK=rough still reads as
// SPOOL_DIA…=rough. Below this the text is smaller than the caption and unreadable.
const NOTE_MIN_SCALE = 0.75;
const ELLIPSIS = '\u2026';
const MAX_STACK = 12;  // give up after this many pushes rather than loop
const LINE = 1.35;     // line height multiple used for every forced stack

const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));

// The neutral grey is a STROKE colour: as text it sits at the ambient's own
// luminance and disappears. Text neutral is the light one the box labels use.
const TEXT = (c) => (c === '#8b97a8' ? '#e8edf4' : c);

const PANELS = new Set(['box', 'doc', 'phone']);
// Shapes a label must not print over. A shield is not a panel — nothing nests in it
// and no note attaches to it — but text across the barrier is the one thing that
// stops it reading as a barrier, so it joins the avoid list.
const AVOID = new Set([...PANELS, 'shield']);
const mk = (x, y, w, h) => ({ x, y, w, h, cx: x + w / 2, cy: y + h / 2, bot: y + h });

// What a label can hang off. Matches the footprints buildShape draws.
function rectOf(sh) {
  if (sh.type === 'box') return mk(sh.x, sh.y, sh.w || 160, sh.h || 120);
  if (sh.type === 'doc') return mk(sh.x, sh.y, 120, 150);
  if (sh.type === 'phone') return mk(sh.x, sh.y, 110, 125);
  if (sh.type === 'person') return mk(sh.x - 25, sh.y - 25, 50, 105);
  if (sh.type === 'shield') return mk(sh.x - 40, sh.y - 40, 80, 80);
  return null;
}

// The label each shape declares, before any placement decision.
export function labelOf(sh) {
  if ((sh.type === 'box' || sh.type === 'person') && sh.label) {
    const p = sh.type === 'person';
    return { owner: sh.id, kind: 'title', person: p, text: sh.label, fill: p ? '#cfc7de' : '#e8edf4', size: p ? 17 : 19, weight: p ? 700 : 800 };
  }
  if (sh.type === 'arrow' && sh.label) {
    return { owner: sh.id, kind: 'edge', text: sh.label, fill: TEXT(sh.color || '#ffd166'), size: 16, weight: 700,
      ax: (sh.x1 + sh.x2) / 2, ay: Math.min(sh.y1, sh.y2) };
  }
  if (sh.type === 'badge' && sh.text) {
    return { owner: sh.id, kind: 'note', text: sh.text, fill: TEXT(sh.color || '#ffd166'), size: 20, weight: 800,
      ax: sh.x, ay: sh.y, standalone: true };
  }
  return null;
}

// One character out of the middle, keeping the head and the tail that make an
// identifier recognisable. Trims the longer side first so both ends survive.
function shorten(text) {
  const i = text.indexOf(ELLIPSIS);
  if (i === -1) {
    if (text.length < 4) return text;
    const mid = text.length >> 1;
    return text.slice(0, mid) + ELLIPSIS + text.slice(mid + 1);
  }
  const head = text.slice(0, i), tail = text.slice(i + 1);
  if (head.length >= tail.length && head.length > 1) return head.slice(0, -1) + ELLIPSIS + tail;
  if (tail.length > 1) return head + ELLIPSIS + tail.slice(1);
  return text;
}

function boxOf(L) {
  L.left = L.x - L.w / 2; L.right = L.x + L.w / 2;
  L.top = L.y - L.asc; L.bot = L.y + L.desc;
  return L;
}
const hits = (a, b) => a.left < b.right + SLOP && b.left < a.right + SLOP
  && a.top < b.bot + GAP && b.top < a.bot + GAP;
const overRect = (L, r) => L.left < r.x + r.w && r.x < L.right && L.top < r.bot && r.y < L.bot;
const within = (L, r) => L.left >= r.x && L.right <= r.x + r.w && L.top >= r.y && L.bot <= r.bot;
const straddles = (L, r) => overRect(L, r) && !within(L, r);
// A label that stops one unit short of a border reads as touching it, so a label
// outside every panel must clear the nearest border by GAP, not by any distance.
const abuts = (L, r) => L.left < r.x + r.w + GAP && r.x - GAP < L.right
  && L.top < r.bot + GAP && r.y - GAP < L.bot;
const holds = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y
  && outer.x + outer.w >= inner.x + inner.w && outer.bot >= inner.bot;

// A panel's four label positions, every one centred on the panel so a label can
// never read as a few pixels off its own box.
function place(L, r, name) {
  L.x = r.cx;
  if (name === 'above') L.y = r.y - PAD - L.desc;
  else if (name === 'insideTop') L.y = r.y + PAD_IN + L.asc;
  else if (name === 'insideBottom') L.y = r.bot - PAD_IN - L.desc;
  else L.y = r.bot + PAD + L.asc;
  L.slot = name;
  return boxOf(L);
}
const INSIDE = new Set(['insideTop', 'insideBottom', 'list']);

// Chain past every blocker in one direction, in whole line steps so even a forced
// stack still reads as a stack.
function push(L, placed, dir) {
  const step = L.size * LINE;
  for (let i = 0; i < MAX_STACK; i++) {
    if (!placed.some((p) => hits(L, p))) return true;
    L.y += dir * step;
    boxOf(L);
    if (L.top < SAFE || L.bot > DIAG_H - SAFE) return false;
  }
  return !placed.some((p) => hits(L, p));
}

// measure(text, size, weight) -> { w, asc, desc } in canvas units.
export function resolveLabels(shapes, measure) {
  const all = shapes || [];
  const rects = new Map();
  const panels = [];
  const list = [];
  const avail = DIAG_W - 2 * SAFE;

  const fit = (L, room) => {
    let m = measure(L.text, L.size, L.weight);
    if (m.w > room) {
      L.size = Math.max(MIN_SIZE, Math.floor(L.size * room / m.w));
      m = measure(L.text, L.size, L.weight);
    }
    L.w = m.w; L.asc = m.asc; L.desc = m.desc;
    return m.w <= room;
  };

  // A badge always ends up fitting: shrink to NOTE_MIN_SCALE of the authored size,
  // then drop characters from the middle until it does. Always restarts from the
  // authored text, because firstSlot tries a slot more than once.
  const fitNote = (L, room) => {
    L.text = L.full ?? L.text;
    let m = measure(L.text, L.size, L.weight);
    if (m.w > room) {
      const floor = Math.max(MIN_SIZE, Math.round((L.base ?? L.size) * NOTE_MIN_SCALE));
      L.size = Math.max(floor, Math.floor(L.size * room / m.w));
      m = measure(L.text, L.size, L.weight);
    }
    while (m.w > room) {
      const next = shorten(L.text);
      if (next === L.text) break;
      L.text = next;
      m = measure(L.text, L.size, L.weight);
    }
    L.w = m.w; L.asc = m.asc; L.desc = m.desc;
    return m.w <= room;
  };

  for (const sh of all) {
    const r = rectOf(sh);
    if (r) { rects.set(sh.id, r); if (AVOID.has(sh.type)) panels.push(PANELS.has(sh.type) ? r : { ...r, mark: true }); }
    const L = labelOf(sh);
    if (!L) continue;
    fit(L, avail);
    L.base = L.size;
    L.full = L.text;
    list.push(L);
  }

  // a slot is only valid if it stays on canvas, fits the panel when it sits
  // inside one, and does not cut across some other panel's border.
  //
  // A shield is on the avoid list so free text never prints across the barrier, but a
  // label sitting INSIDE a panel is drawn on that panel's own dark ground, and a shield
  // whose 80px footprint spills over the panel would otherwise evict the panel's own
  // content to the canvas below it. Measured: two 200-wide boxes with a shield on the
  // wire between them pushed both badges out of their boxes.
  const clearOf = (L, host, inside) =>
    !panels.some((r) => r !== host && !holds(r, host) && !(inside && r.mark) && overRect(L, r));
  const room = (r, name) => (INSIDE.has(name) ? r.w - 2 * PAD_IN : DIAG_W - 2 * SAFE);
  const valid = (L, r, name) => {
    if (L.left < SAFE || L.right > DIAG_W - SAFE || L.top < SAFE || L.bot > DIAG_H - SAFE) return false;
    if (L.w > room(r, name)) return false;
    return clearOf(L, r, INSIDE.has(name));
  };

  // 1. every label that belongs to a shape: titles own their shape, notes attach
  //    to the panel they sit in or hug
  const groups = new Map();
  for (const L of list) {
    if (L.kind === 'title') { L.host = rects.get(L.owner); continue; }
    if (L.kind !== 'note') continue;
    let best = null, bestD = Infinity;
    for (const sh of all) {
      if (!PANELS.has(sh.type)) continue;
      const r = rects.get(sh.id);
      if (L.ax < r.x - HUG || L.ax > r.x + r.w + HUG) continue;
      if (L.ay < r.y - ATTACH || L.ay > r.bot + ATTACH) continue;
      const d = Math.abs(L.ax - r.cx) + Math.abs(L.ay - r.cy);
      if (d < bestD) { bestD = d; best = sh.id; }
    }
    if (!best) continue;
    L.host = rects.get(best);
    if (!groups.has(best)) groups.set(best, []);
    groups.get(best).push(L);
  }

  const placed = [];
  const seat = (L, r, name) => {
    if (L.kind === 'note' && INSIDE.has(name)) fitNote(L, room(r, name));
    else fit(L, room(r, name));
    return place(L, r, name);
  };

  // Every path ends here: pull the label onto the canvas, off any panel border it
  // half covers, and clear of anything already placed. A slot chosen above is
  // already all three, so settle only ever moves the fallbacks.
  // A label seated inside its OWN panel is a title in its own box and stays there. Any
  // other label has to clear every border it comes near, not merely miss it.
  const crowded = (L) => (L.host && within(L, L.host)
    ? panels.some((r) => straddles(L, r))
    : panels.some((r) => abuts(L, r)));

  const settle = (L) => {
    L.x = clamp(L.x, SAFE + L.w / 2, DIAG_W - SAFE - L.w / 2);
    L.y = clamp(L.y, SAFE + L.asc, DIAG_H - SAFE - L.desc);
    boxOf(L);
    const home = L.y;
    if (crowded(L)) {
      // every clean line this label could sit on, nearest to where it wanted to be.
      // A hosted label keeps its column: it is centred on the shape it names.
      const hx = L.x, ys = [home], xs = [hx];
      for (const r of panels) {
        ys.push(r.y - GAP - L.desc, r.bot + GAP + L.asc);
        if (!L.host) xs.push(r.x - GAP - L.w / 2, r.x + r.w + GAP + L.w / 2);
      }
      const spots = [];
      for (const x of xs) for (const y of ys) spots.push({ x, y });
      const ok = spots
        .filter((c) => c.x - L.w / 2 >= SAFE && c.x + L.w / 2 <= DIAG_W - SAFE
          && c.y - L.asc >= SAFE && c.y + L.desc <= DIAG_H - SAFE)
        .sort((a, b) => Math.hypot(a.x - hx, a.y - home) - Math.hypot(b.x - hx, b.y - home))
        .filter((c) => { L.x = c.x; L.y = c.y; boxOf(L); return !crowded(L); });
      const free = ok.find((c) => { L.x = c.x; L.y = c.y; boxOf(L); return !placed.some((p) => hits(L, p)); });
      const at = free || ok[0] || { x: hx, y: home };
      L.x = at.x; L.y = at.y; boxOf(L);
    }
    if (placed.some((p) => hits(L, p))) {
      const back = L.y;
      if (!push(L, placed, +1)) { L.y = back; boxOf(L); push(L, placed, -1); }
    }
    L.y = clamp(L.y, SAFE + L.asc, DIAG_H - SAFE - L.desc);
    boxOf(L);
    placed.push(L);
  };

  const firstSlot = (L, names) => {
    const r = L.host, size0 = L.size;
    let pick = null, spare = null, loose = null;
    for (const name of names) {
      L.size = size0;
      seat(L, r, name);
      if (!loose && L.left >= SAFE && L.right <= DIAG_W - SAFE && L.top >= SAFE && L.bot <= DIAG_H - SAFE) {
        loose = { name, size: L.size };
      }
      if (!valid(L, r, name)) continue;
      const at = { name, size: L.size };
      if (!spare) spare = at;
      if (placed.some((p) => hits(L, p))) continue;
      pick = at; break;
    }
    const at = pick || spare || loose || { name: names[0], size: size0 };
    L.size = at.size;
    seat(L, r, at.name);
    L.homeX = L.x; L.homeY = L.y;
    if (pick) placed.push(L); else settle(L);
  };

  // 2. titles first: a panel's own name outranks any note it carries
  const titles = list.filter((L) => L.kind === 'title' && L.host);
  // a stick figure has no interior, so its name sits above or below it and nowhere else.
  // A panel's title goes INSIDE it first: above the panel the text lands on bare
  // footage and reads as a word floating near a box rather than that box's name.
  const slotsFor = (L) => (L.person ? ['above', 'below'] : ['insideTop', 'above', 'insideBottom', 'below']);
  for (const L of titles) firstSlot(L, slotsFor(L));

  // one title size per diagram: a lone shrunken title among full-size ones is
  // exactly the kind of near-miss that reads as sloppy
  const uniform = Math.min(...titles.map((L) => L.size));
  if (titles.length > 1 && titles.some((L) => L.size !== uniform)) {
    for (const L of titles) { const i = placed.indexOf(L); if (i >= 0) placed.splice(i, 1); }
    for (const L of titles) { L.size = uniform; firstSlot(L, slotsFor(L)); }
  }

  // 3. a row of panels shares one title baseline, so near-equal tops stop reading ragged
  const above = titles.filter((L) => L.slot === 'above');
  for (const L of above) {
    if (L.rowDone) continue;
    const row = above.filter((o) => Math.abs(o.host.y - L.host.y) <= ROW_EPS);
    const y = Math.min(...row.map((o) => o.y));
    for (const o of row) {
      o.rowDone = true;
      const back = o.y; o.y = y; boxOf(o);
      const clash = placed.some((p) => p !== o && hits(o, p));
      if (!clearOf(o, o.host, false) || o.top < SAFE || clash) { o.y = back; boxOf(o); }
    }
  }

  // 4. several notes on one panel are a list: one size, evenly spaced, centred,
  //    filling whatever interior the panel's title left free
  for (const [id, group] of groups) {
    const r = rects.get(id);
    if (group.length < 2) continue;
    const wide = r.w - 2 * PAD_IN;
    for (const L of group) fitNote(L, wide);
    const size = Math.min(...group.map((L) => L.size));
    for (const L of group) { L.size = size; fitNote(L, wide); }
    const step = size * LINE;
    let top = r.y + PAD_IN, bot = r.bot - PAD_IN;
    const own = titles.find((L) => L.host === r && INSIDE.has(L.slot));
    if (own) { if (own.slot === 'insideTop') top = own.bot + GAP; else bot = own.top - GAP; }
    if (group.length * step > bot - top) continue;
    group.sort((a, b) => a.ay - b.ay);
    const span = bot - top - step;
    group.forEach((L, i) => {
      L.x = r.cx;
      L.y = top + L.asc + i * span / (group.length - 1);
      L.slot = 'list'; boxOf(L); L.done = true;
      L.homeX = L.x; L.homeY = L.y;
      placed.push(L);
    });
  }

  // 5. a hosted note takes the interior slot nearest where it was anchored
  // A hosted badge never leaves its box. fitNote guarantees the width, so the only
  // question left is which interior slot it takes: the one nearest its anchor, or the
  // other one if that collides with the panel's own title. A badge sharing its box
  // with a title beats a badge sitting on the canvas below the box.
  const insideOrder = (L, r) => (L.ay < r.cy ? ['insideTop', 'insideBottom'] : ['insideBottom', 'insideTop']);
  for (const L of list) {
    if (!L.host || L.done || L.kind !== 'note') continue;
    const r = L.host;
    const names = insideOrder(L, r);
    let chosen = null;
    for (const name of names) {
      L.size = L.base;
      seat(L, r, name);
      if (!chosen) chosen = { name, size: L.size };
      if (!placed.some((p) => hits(L, p))) { chosen = { name, size: L.size }; break; }
    }
    L.size = chosen.size;
    seat(L, r, chosen.name);
    // The interior can be shorter than the glyphs on a small panel; keep the text on
    // the panel rather than letting it hang off the edge it belongs to.
    L.y = clamp(L.y, r.y + L.asc, r.bot - L.desc);
    boxOf(L);
    L.homeX = L.x; L.homeY = L.y;
    placed.push(L);
  }

  // 6. free notes and edge labels: snap to a nearby centre line, then keep clear
  for (const L of list) {
    if (L.done || L.host) continue;
    if (L.kind === 'edge') { L.x = L.ax; L.y = L.ay - PAD - L.desc; } else {
      L.x = L.ax; L.y = L.ay;
      for (const r of rects.values()) if (Math.abs(r.cx - L.ax) <= SNAP_EPS) { L.x = r.cx; break; }
    }
    boxOf(L);
    L.homeX = L.x; L.homeY = L.y;
    settle(L);
  }

  // 7. a free note driven off its anchor keeps a thread back to what it marks;
  //    hosted labels never need one, they always land on a slot of their own shape
  for (const L of placed) {
    if (L.host || L.kind === 'edge') continue;
    if (Math.hypot(L.x - L.homeX, L.y - L.homeY) <= LEADER_MIN) continue;
    const near = L.y < L.homeY;
    L.leader = { x1: L.x, y1: near ? L.bot + 3 : L.top - 3, x2: L.homeX, y2: L.homeY };
  }
  return placed;
}

#!/usr/bin/env node
// Diagram lint: deterministic gate for the diagrammer's DSL output.
// Importable as lintDiagrams(); as a CLI: diaglint.mjs <diagrams.json> <beats.json>,
// exit 0 clean / 1 with findings. Coverage is the point — a bare beat is dead air.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The authoring canvas is SQUARE. A 480x260 spec is 1.85 wide, so a vertical frame
// fits it on width and the diagram only ever reached a quarter of the frame height.
const W = 480, H = 480, MARGIN = 12;
const TYPES = {
  box: ['x', 'y'], squiggle: ['x', 'y'], doc: ['x', 'y'], phone: ['x', 'y'],
  person: ['x', 'y'], arrow: ['x1', 'y1', 'x2', 'y2'], wire: ['x1', 'y1', 'x2', 'y2'],
  cross: ['x', 'y'], badge: ['x', 'y'], dot: ['x', 'y'], shield: ['x', 'y'],
};
// Footprint each type occupies, so a shape that would clip the canvas is caught here
// rather than half-drawn on screen. Text is excluded: layout.mjs places that.
const BOXES = {
  box: (s) => [s.x, s.y, s.w || 160, s.h || 120],
  doc: (s) => [s.x, s.y, 120, 150],
  phone: (s) => [s.x, s.y, 110, 125],
  squiggle: (s) => [s.x, s.y - 14, 110, 60],
  person: (s) => [s.x - 25, s.y - 25, 50, 105],
  cross: (s) => [s.x - 18, s.y - 18, 36, 36],
  dot: (s) => [s.x - 9, s.y - 9, 18, 18],
  // The bar rotates with `angle`, so the footprint is its circumradius (39.7 from
  // the tick tips) squared off — it has to hold at every angle, not just at zero.
  shield: (s) => [s.x - 40, s.y - 40, 80, 80],
};
const PANELS = new Set(['box', 'doc', 'phone']);
// The only types layout.mjs renders text for (box/person title, arrow edge, badge note).
const LABELLED = new Set(['box', 'person', 'arrow', 'badge']);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
// How far a shield's centre may sit from the arrow it stops. Roughly the bar's own
// half-length, so it still visibly crosses the line.
const SHIELD_ON_LINE = 30;

function distToSegment(p, l) {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - l.x1) * dx + (p.y - l.y1) * dy) / len2)) : 0;
  return Math.hypot(p.x - (l.x1 + t * dx), p.y - (l.y1 + t * dy));
}

/**
 * Fix the mechanical mistakes in place, so a model retry is spent on meaning.
 *
 * Two failure classes dominate every run and neither is a judgement call: a shape
 * whose footprint hangs off the canvas, and a shield floating beside the arrow it is
 * meant to stop. The linter already computes both exactly, so the numbers that prove
 * the mistake also fix it — clamp the shape in, project the shield onto its line.
 * Everything else (a label that restates the narration, a missing diagram) is left
 * alone, because repairing those would be inventing a layout rather than correcting
 * one. Returns a new spec plus what it touched.
 *
 * A badge travels with the box it was placed in. Without that, both movers below
 * produce the exact defect the linter then reports: the box slides, the artifact stays
 * behind, and the next draft is spent putting a word back where it already was.
 */
export function repairDiagrams(spec) {
  if (!Array.isArray(spec)) return { spec, repairs: [] };
  const repairs = [];
  const fixed = spec.map((e) => {
    if (!e?.diagram?.shapes) return e;
    const lines = e.diagram.shapes.filter((s) => (s.type === 'arrow' || s.type === 'wire') && typeof s.x1 === 'number');
    const riders = ridersOf(e.diagram.shapes);
    const moved = new Map();
    const shapes = e.diagram.shapes.map((s) => {
      let out = s;
      // A shield belongs ON the flow it stops: project its centre onto the nearest
      // segment rather than asking for another draft of the same picture.
      if (out.type === 'shield' && lines.length && typeof out.x === 'number' && typeof out.y === 'number') {
        const near = lines.map((l) => ({ l, d: distToSegment(out, l) })).sort((a, b) => a.d - b.d)[0];
        if (near.d > SHIELD_ON_LINE) {
          const p = closestPoint(out, near.l);
          out = { ...out, x: Math.round(p.x), y: Math.round(p.y) };
          repairs.push(`[${e.beat}] moved shield "${s.id}" onto "${near.l.id}"`);
        }
      }
      const bx = BOXES[out.type] ? BOXES[out.type](out) : null;
      if (bx) {
        const [x, y, w, h] = bx;
        const nx = Math.min(Math.max(x, MARGIN), W - MARGIN - w);
        const ny = Math.min(Math.max(y, MARGIN), H - MARGIN - h);
        // Only shift what actually fits; a shape wider than the canvas is a spec
        // problem the model has to solve.
        if ((nx !== x || ny !== y) && w <= W - 2 * MARGIN && h <= H - 2 * MARGIN) {
          out = { ...out, x: out.x + (nx - x), y: out.y + (ny - y) };
          bump(moved, s.id, nx - x, ny - y);
          repairs.push(`[${e.beat}] nudged "${s.id}" back inside the canvas`);
        }
      }
      return out;
    });
    const spread = separatePanels(shapes, e.beat, repairs, moved);
    const clear = clearMarks(carryRiders(spread, riders, moved), e.beat, repairs);
    return { ...e, diagram: { ...e.diagram, shapes: uncross(clear, e.beat, repairs) } };
  });
  return { spec: fixed, repairs };
}

const bump = (moved, id, dx, dy) => {
  const at = moved.get(id) || { dx: 0, dy: 0 };
  moved.set(id, { dx: at.dx + dx, dy: at.dy + dy });
};

/** Which box each badge started inside, read off the coordinates before any move. */
function ridersOf(shapes) {
  const boxes = shapes.filter((s) => s.type === 'box' && typeof s.x === 'number' && typeof s.y === 'number');
  const out = new Map();
  for (const s of shapes) {
    if (s.type !== 'badge' || typeof s.x !== 'number' || typeof s.y !== 'number') continue;
    const host = boxes.find((b) => {
      const w = b.w || 160, h = b.h || 120;
      return s.x >= b.x && s.x <= b.x + w && s.y >= b.y && s.y <= b.y + h;
    });
    if (host) out.set(s.id, host.id);
  }
  return out;
}

/** Shift every badge by whatever its box was shifted, so content stays in its panel. */
function carryRiders(shapes, riders, moved) {
  if (!riders.size) return shapes;
  return shapes.map((s) => {
    const d = moved.get(riders.get(s.id));
    return d && (d.dx || d.dy) ? { ...s, x: s.x + d.dx, y: s.y + d.dy } : s;
  });
}

// Clear space every pair of panels keeps. Panels 6px apart dock their arrow down to
// nothing, so the row reads as one slab with no flow through it.
export const PANEL_GAP = 24;
const GAP = PANEL_GAP;

/**
 * Push partially-overlapping panels apart along their shallower axis.
 *
 * Half-overlapping panels are 48% of every gate failure measured, and no model does
 * this arithmetic reliably — gpt-5 produced five in one draft. Packing rectangles is
 * a solved problem in code, so it is solved in code: the model decides WHAT is beside
 * what, this keeps its arrangement and just stops the boxes touching. A fully nested
 * panel is left alone, because that nesting is a real layout (rows inside a screen).
 */
function separatePanels(shapes, beat, repairs, moved) {
  const idx = shapes.map((s, i) => ({ s, i })).filter(({ s }) => PANELS.has(s.type) && BOXES[s.type]);
  if (idx.length < 2) return shapes;
  const out = shapes.slice();
  const rect = (s) => BOXES[s.type](s);
  const inside = (a, c) => a[0] >= c[0] && a[1] >= c[1] && a[0] + a[2] <= c[0] + c[2] && a[1] + a[3] <= c[1] + c[3];

  for (let pass = 0; pass < 4; pass++) {
    let any = false;
    for (let m = 0; m < idx.length; m++) {
      for (let n = m + 1; n < idx.length; n++) {
        const A = rect(out[idx[m].i]), B = rect(out[idx[n].i]);
        // Overlap measured with GAP already added, so ox/oy is the distance to move
        // to reach real clearance and a merely-touching pair is separated too.
        const ox = Math.min(A[0] + A[2], B[0] + B[2]) - Math.max(A[0], B[0]) + GAP;
        const oy = Math.min(A[1] + A[3], B[1] + B[3]) - Math.max(A[1], B[1]) + GAP;
        if (ox <= 0 || oy <= 0 || inside(A, B) || inside(B, A)) continue;

        // Try every way out and take the smallest: either panel, either axis, keeping
        // the side each is already on so the model's arrangement survives. Moving one
        // down may be impossible where moving the other up is trivial, and giving up
        // on the first blocked direction is what left overlaps behind.
        const options = [];
        for (const [k, rMe, rOther] of [[idx[n].i, B, A], [idx[m].i, A, B]]) {
          for (const horizontal of [ox <= oy, ox > oy]) {
            const push = horizontal ? ox : oy;
            const dir = horizontal
              ? (rMe[0] + rMe[2] / 2 >= rOther[0] + rOther[2] / 2 ? 1 : -1)
              : (rMe[1] + rMe[3] / 2 >= rOther[1] + rOther[3] / 2 ? 1 : -1);
            const span = horizontal ? rMe[2] : rMe[3];
            const limit = (horizontal ? W : H) - MARGIN - span;
            const from = horizontal ? rMe[0] : rMe[1];
            const to = Math.min(Math.max(from + dir * push, MARGIN), limit);
            if (Math.abs(to - from) >= push) options.push({ k, key: horizontal ? 'x' : 'y', delta: to - from });
          }
        }
        // Take the smallest move that lands CLEAR of every other panel. Without this
        // check the repair just shuffles the collision: measured, it walked a phone
        // out of one box and straight into another.
        const clear = options
          .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))
          .find(({ k, key, delta }) => {
            const moved = { ...out[k], [key]: out[k][key] + delta };
            const r = rect(moved);
            return !idx.some(({ i }) => {
              if (i === k) return false;
              const o = rect(out[i]);
              const hit = r[0] < o[0] + o[2] + GAP && o[0] < r[0] + r[2] + GAP
                && r[1] < o[1] + o[3] + GAP && o[1] < r[1] + r[3] + GAP;
              return hit && !inside(r, o) && !inside(o, r);
            });
          });
        if (!clear) continue; // boxed in; the model has to redraw this one
        out[clear.k] = { ...out[clear.k], [clear.key]: out[clear.k][clear.key] + clear.delta };
        if (moved) bump(moved, out[clear.k].id, clear.key === 'x' ? clear.delta : 0, clear.key === 'y' ? clear.delta : 0);
        any = true;
      }
    }
    if (!any) break;
    if (pass === 0) repairs.push(`[${beat}] spread panels to ${GAP}px clearance`);
  }
  return out;
}

// How far a mark keeps off a panel border, and how far a dot keeps off an arrow tip.
// The tip number is the arrowhead's own 11px plus the dot's 9px radius.
const MARK_CLEAR = 15, HEAD_CLEAR = 20;

const panelRects = (shapes) => shapes
  .filter((s) => PANELS.has(s.type) && typeof s.x === 'number' && typeof s.y === 'number')
  .map((s) => BOXES[s.type](s));

/** True when a point sits on a panel, counting pad units outside its border. */
export const onPanel = (x, y, rects, pad = 0) => rects.some(([px, py, pw, ph]) =>
  x > px - pad && x < px + pw + pad && y > py - pad && y < py + ph + pad);

/**
 * A mark is drawn on the SPACE between panels, never on one.
 *
 * A dot inside a box prints over that box's title or its badge and reads as a smudge,
 * not as a ping — the audited recap has one sitting on the word "panel". A shield
 * inside a box strikes the title out instead of barring the flow. Both are geometry,
 * so both are moved rather than sent back for another draft: the shield slides along
 * the line it stops, the dot steps out of the panel by its nearest border.
 */
function clearMarks(shapes, beat, repairs) {
  const rects = panelRects(shapes);
  const lines = shapes.filter((s) => (s.type === 'arrow' || s.type === 'wire') && typeof s.x1 === 'number');
  if (!rects.length) return shapes;
  return shapes.map((s) => {
    if (typeof s.x !== 'number' || typeof s.y !== 'number') return s;
    if (s.type === 'shield') {
      if (!onPanel(s.x, s.y, rects)) return s;
      const spot = freePointOn(s, lines, rects);
      if (!spot) return s;
      repairs.push(`[${beat}] slid shield "${s.id}" off the panel it was drawn across`);
      return { ...s, x: Math.round(spot.x), y: Math.round(spot.y) };
    }
    if (s.type !== 'dot') return s;
    let out = s;
    const hit = rects.find(([x, y, w, h]) => out.x > x - MARK_CLEAR && out.x < x + w + MARK_CLEAR
      && out.y > y - MARK_CLEAR && out.y < y + h + MARK_CLEAR);
    if (hit) {
      out = { ...out, ...shove(out, hit) };
      repairs.push(`[${beat}] moved dot "${s.id}" off the panel it was printing on`);
    }
    for (const l of lines) {
      const d = Math.hypot(out.x - l.x2, out.y - l.y2);
      if (d >= HEAD_CLEAR) continue;
      const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1) || 1;
      out = { ...out, x: Math.round(l.x2 - ((l.x2 - l.x1) / len) * HEAD_CLEAR),
        y: Math.round(l.y2 - ((l.y2 - l.y1) / len) * HEAD_CLEAR) };
      repairs.push(`[${beat}] pulled dot "${s.id}" back off the arrowhead of "${l.id}"`);
      break;
    }
    return out;
  });
}

/** Step a mark out of the panel it landed in, by whichever border is nearest. */
function shove(s, [x, y, w, h]) {
  const outs = [
    { x: x - MARK_CLEAR, y: s.y }, { x: x + w + MARK_CLEAR, y: s.y },
    { x: s.x, y: y - MARK_CLEAR }, { x: s.x, y: y + h + MARK_CLEAR },
  ].filter((p) => p.x >= MARGIN && p.x <= W - MARGIN && p.y >= MARGIN && p.y <= H - MARGIN);
  const at = outs.sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y))[0];
  return at ? { x: Math.round(at.x), y: Math.round(at.y) } : {};
}

/** Nearest point on any of these lines that is clear of every panel. */
function freePointOn(mark, lines, rects) {
  let best = null, bestD = Infinity;
  for (const l of lines) {
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      const p = { x: l.x1 + (l.x2 - l.x1) * u, y: l.y1 + (l.y2 - l.y1) * u };
      if (onPanel(p.x, p.y, rects)) continue;
      const d = Math.hypot(p.x - mark.x, p.y - mark.y);
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  return best;
}

// The point on a segment closest to p — where a misplaced shield should have been.
function closestPoint(p, l) {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - l.x1) * dx + (p.y - l.y1) * dy) / len2)) : 0;
  return { x: l.x1 + t * dx, y: l.y1 + t * dy };
}

// ---------- crossing flows ----------
// Two arrows meeting in an X is the one diagram defect a viewer reads as an ERROR: it
// says the mechanism doubles back on itself when it does not, and the audited recap has
// a frame of it. Segment intersection is exact arithmetic, so it is checked, and it is
// repaired the way a person would — bend one flow around the other.

/** A connector as its legs, so an elbowed edge is two segments and not one. */
function legs(s) {
  if (typeof s.x1 !== 'number') return [];
  if (!s.via) return [{ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 }];
  return [
    { x1: s.x1, y1: s.y1, x2: s.via.x, y2: s.via.y },
    { x1: s.via.x, y1: s.via.y, x2: s.x2, y2: s.y2 },
  ];
}

const side = (l, x, y) => Math.sign((l.x2 - l.x1) * (y - l.y1) - (l.y2 - l.y1) * (x - l.x1));
// Ends that meet are a junction, not a crossing; only a PROPER interior intersection counts.
const JOIN = 8;

function legsCross(a, b) {
  for (const p of [[a.x1, a.y1], [a.x2, a.y2]]) {
    for (const q of [[b.x1, b.y1], [b.x2, b.y2]]) {
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < JOIN) return false;
    }
  }
  const d1 = side(b, a.x1, a.y1), d2 = side(b, a.x2, a.y2);
  const d3 = side(a, b.x1, b.y1), d4 = side(a, b.x2, b.y2);
  return d1 && d2 && d3 && d4 && d1 !== d2 && d3 !== d4;
}

/** True when two connectors intersect anywhere other than at a shared end. */
export function edgesCross(a, b) {
  return legs(a).some((la) => legs(b).some((lb) => legsCross(la, lb)));
}

/**
 * Bend one of a crossing pair around the other, or leave the pair for the author.
 *
 * The corner is one of the two orthogonal elbows the edge already implies, so the flow
 * still runs between the same two boxes and nothing else in the beat moves. A corner is
 * only taken when it lands off every panel, inside the canvas, and clear of every other
 * flow — otherwise the crossing survives to lintDiagrams and fails the draft.
 */
function uncross(shapes, beat, repairs) {
  const out = shapes.slice();
  const idx = out.map((s, i) => ({ s, i })).filter(({ s }) => (s.type === 'arrow' || s.type === 'wire') && typeof s.x1 === 'number');
  if (idx.length < 2) return out;
  const rects = panelRects(out);
  const clean = (cand, self) => idx.every(({ i }) => i === self || !edgesCross(cand, out[i]));

  for (let pass = 0; pass < 3; pass++) {
    let any = false;
    for (let m = 0; m < idx.length; m++) {
      for (let n = m + 1; n < idx.length; n++) {
        const A = out[idx[m].i], B = out[idx[n].i];
        if (!edgesCross(A, B)) continue;
        let fixed = false;
        for (const { s, i } of [idx[n], idx[m]]) {
          if (fixed || out[i].via) continue;
          const e = out[i];
          const mx = Math.round((e.x1 + e.x2) / 2), my = Math.round((e.y1 + e.y2) / 2);
          for (const via of [{ x: mx, y: e.y1 }, { x: mx, y: e.y2 }, { x: e.x1, y: my },
            { x: e.x2, y: my }, { x: e.x1, y: e.y2 }, { x: e.x2, y: e.y1 }]) {
            if (via.x < MARGIN || via.x > W - MARGIN || via.y < MARGIN || via.y > H - MARGIN) continue;
            if (onPanel(via.x, via.y, rects, 10)) continue;
            const cand = { ...e, via };
            if (!clean(cand, i)) continue;
            out[i] = cand;
            repairs.push(`[${beat}] bent "${s.id}" around "${(i === idx[n].i ? A : B).id}" so the two flows stop crossing`);
            fixed = true; any = true;
            break;
          }
        }
      }
    }
    if (!any) break;
  }
  return out;
}

/** Words and characters a badge may carry. The characters are what the panel binds. */
export const BADGE_WORDS = 6;
export const BADGE_CHARS = 24;
// Width one character takes at layout.mjs's 13px font floor, plus its PAD_IN either
// side. A badge past this is drawn shrunken or pushed out of the box it belongs to.
/** Badges one box can stack under its own title before layout.mjs runs out of room. */
const BADGES_PER_BOX = 2;
// Smallest box that holds a title and a badge under it. Three panels at PANEL_GAP
// clearance leave (480 - 24 - 2*24)/3 = 136 each, so the floor has to clear that row.
const CONTENT_W = 136, CONTENT_H = 100;

/**
 * Every box carries a real artifact, and every artifact sits in a box.
 *
 * The audited recaps are boxes with a word floating above them and a flat dark fill
 * inside, which is what the DSL's default draws when nothing is placed in the panel.
 * `badge` is the only shape that puts text INSIDE a panel (layout.mjs seats a note on
 * the panel it is anchored in), so "a box has content" and "a badge is anchored in a
 * box" are the same rule read from both ends, and both ends are checked here.
 */
function contentFindings(shapes, beat, add) {
  const boxes = shapes.filter((s) => s.type === 'box' && typeof s.x === 'number' && typeof s.y === 'number');
  const badges = shapes.filter((s) => s.type === 'badge' && typeof s.x === 'number' && typeof s.y === 'number');
  const rectOf = (s) => [s.x, s.y, s.w || 160, s.h || 120];
  const holder = (bd) => boxes.find((bx) => {
    const [x, y, w, h] = rectOf(bx);
    return bd.x >= x && bd.x <= x + w && bd.y >= y && bd.y <= y + h;
  });

  const held = new Map();
  for (const bd of badges) {
    const box = holder(bd);
    if (!box) {
      add(beat, `"${bd.id}" floats on the background — a badge is the content of a box, so put it inside one, in the lower half`);
      continue;
    }
    // A badge too wide for its box used to be a finding here. layout.mjs now fits it —
    // shrink to 75% of the authored size, then middle-ellipsize — and seats a hosted
    // badge only inside its panel, so the width is guaranteed before anything is drawn.
    // Asking the model to shorten an identifier it read out of the diff cost a
    // re-author and failed jobs, for a defect the renderer had already handled.
    if (bd.text && box.label && norm(bd.text).join(' ') === norm(box.label).join(' ')) {
      add(beat, `"${bd.id}" repeats the label of "${box.id}" — the label names the part, the badge carries the artifact`);
    }
    held.set(box.id, (held.get(box.id) || 0) + 1);
  }

  for (const bx of boxes) {
    const n = held.get(bx.id) || 0;
    if (!n) {
      add(beat, `"${bx.id}" is an empty box — put a badge inside it carrying a real artifact from the change: an identifier, a value, a state or a count`);
    } else if (n > BADGES_PER_BOX) {
      add(beat, `"${bx.id}" holds ${n} badges — ${BADGES_PER_BOX} is all that fits under its title`);
    }
    const [, , w, h] = rectOf(bx);
    if (n && (w < CONTENT_W || h < CONTENT_H)) {
      add(beat, `"${bx.id}" is ${w}x${h} and carries content — a box with a badge in it needs to be at least ${CONTENT_W}x${CONTENT_H}`);
    }
  }
}

/**
 * A mark drawn ON a panel is a smudge, not a mark.
 *
 * A dot inside a box lands on that box's title or its badge; a shield inside a box
 * strikes the title out rather than barring a flow. repairDiagrams moves both, so a
 * finding here means the move had nowhere to go and the beat has to be redrawn.
 */
function markFindings(shapes, beat, add) {
  const rects = shapes
    .filter((s) => PANELS.has(s.type) && typeof s.x === 'number' && typeof s.y === 'number')
    .map((s) => BOXES[s.type](s));
  if (!rects.length) return;
  for (const s of shapes) {
    if (typeof s.x !== 'number' || typeof s.y !== 'number') continue;
    if (s.type === 'dot' && onPanel(s.x, s.y, rects, 9)) {
      add(beat, `"${s.id}" is a dot drawn on a panel — a ping goes on the space between panels, not over a title or a badge`);
    }
    if (s.type === 'shield' && onPanel(s.x, s.y, rects)) {
      add(beat, `"${s.id}" is a shield drawn inside a panel — put it on the arrow between the panels, so it bars the flow instead of striking out the title`);
    }
  }
}

/** Every finding against a diagram spec paired with its beats — empty means render. */
/**
 * Lint a diagram spec. Returns the findings, with the TASTE ones also listed on a
 * `soft` property of the returned array.
 *
 * Two classes, because they fail differently. A structural finding describes something
 * the viewer will see as broken: an empty box, a badge outside its box, panels on top
 * of one another, geometry off the canvas, a beat with no diagram. A taste finding
 * describes something merely worse than it could be: a label echoing the narration, a
 * badge repeating its box's name, wording longer than the house limit.
 *
 * The gate spends its last attempt on structure only. A taste finding that survives two
 * drafts is not going to be argued away by a third, and holding the whole recap back
 * for one is how three prod jobs were retired without publishing anything.
 */
export function lintDiagrams(spec, beats) {
  if (!Array.isArray(spec)) return ['[shape] expected an array of {beat, diagram} entries'];
  const findings = [];
  const soft = [];
  const add = (beat, msg, taste = false) => {
    const line = `[${beat}] ${msg}`;
    findings.push(line);
    if (taste) soft.push(line);
  };

  if (spec.length !== beats.length) {
    findings.push(`[coverage] ${spec.length} entries for ${beats.length} beats — return one entry per beat, in order`);
  }

  beats.forEach((b, i) => {
    const e = spec[i];
    if (!e || e.beat !== b.name) {
      add(b.name, `entry ${i} is "${e ? e.beat : 'missing'}" — entries must match the beats in order`);
      return;
    }
    if (!e.diagram) {
      if (i !== beats.length - 1) add(b.name, 'no diagram — every beat needs one except a closing ask');
      return;
    }
    const shapes = e.diagram.shapes || [];
    if (shapes.length < 3) add(b.name, `${shapes.length} shape(s) — a mechanism needs at least 3`);

    const ids = new Set();
    const panels = [];
    const said = ' ' + norm(b.narration || '').join(' ') + ' ';
    for (const s of shapes) {
      if (!s.id) { add(b.name, `a ${s.type} shape has no id`); continue; }
      if (ids.has(s.id)) add(b.name, `duplicate id "${s.id}"`);
      ids.add(s.id);
      const req = TYPES[s.type];
      if (!req) { add(b.name, `"${s.id}": unknown type "${s.type}"`); continue; }
      for (const k of req) if (typeof s[k] !== 'number') add(b.name, `"${s.id}": ${k} must be a number`);

      const bx = BOXES[s.type] ? BOXES[s.type](s) : null;
      if (bx) {
        const [x, y, w, h] = bx;
        if (x < MARGIN || y < MARGIN || x + w > W - MARGIN || y + h > H - MARGIN) {
          add(b.name, `"${s.id}" runs outside the ${W}x${H} canvas (${Math.round(x)},${Math.round(y)} ${w}x${h})`);
        }
        if (PANELS.has(s.type)) {
          // nesting a panel inside another is a real layout (rows in a screen);
          // a partial overlap is two things colliding.
          const inside = (a, c) => a[0] >= c[0] && a[1] >= c[1] && a[0] + a[2] <= c[0] + c[2] && a[1] + a[3] <= c[1] + c[3];
          const me = [x, y, w, h];
          for (const p of panels) {
            const touch = x < p[0] + p[2] && p[0] < x + w && y < p[1] + p[3] && p[1] < y + h;
            if (touch && !inside(me, p) && !inside(p, me)) { add(b.name, `panels "${s.id}" and "${p[4]}" overlap`); continue; }
            if (inside(me, p) || inside(p, me)) continue;
            // Panels that merely miss each other dock their arrow down to nothing, so
            // the row draws as one slab with no flow through it.
            const gx = Math.max(p[0] - (x + w), x - (p[0] + p[2]));
            const gy = Math.max(p[1] - (y + h), y - (p[1] + p[3]));
            const near = Math.max(gx, gy);
            if (near < PANEL_GAP) {
              add(b.name, `panels "${s.id}" and "${p[4]}" are ${Math.round(near)}px apart — leave ${PANEL_GAP}px so the arrow between them has a visible length`);
            }
          }
          panels.push([...me, s.id]);
        }
      }
      const text = s.label || s.text;
      // layout.mjs only ever draws text for these four; a label anywhere else is
      // dropped without a word, which is worse than being told to move it.
      if (text && !LABELLED.has(s.type)) {
        add(b.name, `"${s.id}": a ${s.type} cannot carry a label — put it on the box, person or arrow it belongs to`);
      } else if (text) {
        const tw = norm(text);
        // A badge is the artifact, not a label: it keeps the change's own casing and
        // gets more words, but it has to fit the panel it sits in.
        const cap = s.type === 'badge' ? BADGE_WORDS : 4;
        if (tw.length > cap) add(b.name, `"${s.id}": ${s.type === 'badge' ? 'badge' : 'label'} "${text}" is ${tw.length} words — keep it to ${cap}`, true);
        if (s.type === 'badge' && text.length > BADGE_CHARS) {
          // layout.mjs fits the badge to the box now, so this is a house limit on
          // wording rather than a rendering fault.
          add(b.name, `"${s.id}": badge "${text}" is ${text.length} characters — keep it to ${BADGE_CHARS}`, true);
        }
        // A badge is exempt: the artifact it carries is very often the identifier the
        // line names out loud, and seeing it written is the point.
        if (s.type !== 'badge' && tw.length >= 3 && said.includes(' ' + tw.join(' ') + ' ')) {
          add(b.name, `"${s.id}": label "${text}" repeats the narration — labels name parts, the caption says the sentence`, true);
        }
      }
    }

    contentFindings(shapes, b.name, add);
    markFindings(shapes, b.name, add);

    // A shield only means "stopped" if it sits ON the thing being stopped. Parked on
    // the target instead, it reads as a mark scribbled over that shape — the same
    // ambiguity the cross had, one step quieter. This is geometry, so it is checkable.
    const lines = shapes.filter((s) => s.type === 'arrow' || s.type === 'wire');
    for (const s of shapes.filter((s) => s.type === 'shield')) {
      if (typeof s.x !== 'number' || typeof s.y !== 'number') continue;
      if (!lines.length) {
        add(b.name, `"${s.id}": a shield needs an arrow or a wire to stop — draw the flow it blocks`);
        continue;
      }
      const near = Math.min(...lines.map((l) => distToSegment(s, l)));
      if (near > SHIELD_ON_LINE) {
        add(b.name, `"${s.id}" is ${Math.round(near)}px off every arrow — put the shield ON the line it stops, between the source and what survives`);
      }
    }

    // Two flows meeting in an X read as a mechanism that doubles back. repairDiagrams
    // bends one of them where it can, so a finding here means neither would bend.
    const flows = shapes.filter((s) => (s.type === 'arrow' || s.type === 'wire') && typeof s.x1 === 'number');
    for (let m = 0; m < flows.length; m++) {
      for (let n = m + 1; n < flows.length; n++) {
        if (!edgesCross(flows[m], flows[n])) continue;
        add(b.name, `"${flows[m].id}" and "${flows[n].id}" cross — flows must never intersect, so move the boxes they connect until each runs clear`);
      }
    }

    const anims = e.diagram.anims || [];
    for (const a of anims) if (!ids.has(a.target)) add(b.name, `anim targets unknown shape "${a.target}"`);
    if (anims.length && Math.min(...anims.map((a) => a.at ?? 0)) > 0.4) {
      add(b.name, 'nothing appears in the first 0.4s — the diagram must assemble with the narration');
    }
  });

  return Object.assign(findings, { soft });
}

const isMain = resolve(process.argv[1] || '') === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const [specPath, beatsPath] = process.argv.slice(2);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const beats = JSON.parse(readFileSync(beatsPath, 'utf8'));
  const findings = lintDiagrams(spec, beats);
  if (findings.length) {
    console.error(`DIAGRAM LINT: ${findings.length} finding(s)`);
    for (const f of findings) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`diagram lint: clean (${spec.filter((e) => e.diagram).length}/${beats.length} beats drawn)`);
}

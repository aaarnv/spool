#!/usr/bin/env node
// Diagram lint: deterministic gate for the diagrammer's DSL output.
// Importable as lintDiagrams(); as a CLI: diaglint.mjs <diagrams.json> <beats.json>,
// exit 0 clean / 1 with findings. Coverage is the point — a bare beat is dead air.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const W = 480, H = 260, MARGIN = 12;
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
 * Everything else (overlapping panels, a label that restates the narration, a missing
 * diagram) is left alone, because repairing those would be inventing a layout rather
 * than correcting one. Returns a new spec plus what it touched.
 */
export function repairDiagrams(spec) {
  if (!Array.isArray(spec)) return { spec, repairs: [] };
  const repairs = [];
  const fixed = spec.map((e) => {
    if (!e?.diagram?.shapes) return e;
    const lines = e.diagram.shapes.filter((s) => (s.type === 'arrow' || s.type === 'wire') && typeof s.x1 === 'number');
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
          repairs.push(`[${e.beat}] nudged "${s.id}" back inside the canvas`);
        }
      }
      return out;
    });
    return { ...e, diagram: { ...e.diagram, shapes: separatePanels(shapes, e.beat, repairs) } };
  });
  return { spec: fixed, repairs };
}

const GAP = 20; // clear space the prompt asks for between panel edges

/**
 * Push partially-overlapping panels apart along their shallower axis.
 *
 * Half-overlapping panels are 48% of every gate failure measured, and no model does
 * this arithmetic reliably — gpt-5 produced five in one draft. Packing rectangles is
 * a solved problem in code, so it is solved in code: the model decides WHAT is beside
 * what, this keeps its arrangement and just stops the boxes touching. A fully nested
 * panel is left alone, because that nesting is a real layout (rows inside a screen).
 */
function separatePanels(shapes, beat, repairs) {
  const idx = shapes.map((s, i) => ({ s, i })).filter(({ s }) => PANELS.has(s.type) && BOXES[s.type]);
  if (idx.length < 2) return shapes;
  const out = shapes.slice();
  const rect = (s) => BOXES[s.type](s);
  const inside = (a, c) => a[0] >= c[0] && a[1] >= c[1] && a[0] + a[2] <= c[0] + c[2] && a[1] + a[3] <= c[1] + c[3];

  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let m = 0; m < idx.length; m++) {
      for (let n = m + 1; n < idx.length; n++) {
        const A = rect(out[idx[m].i]), B = rect(out[idx[n].i]);
        const ox = Math.min(A[0] + A[2], B[0] + B[2]) - Math.max(A[0], B[0]);
        const oy = Math.min(A[1] + A[3], B[1] + B[3]) - Math.max(A[1], B[1]);
        if (ox <= 0 || oy <= 0 || inside(A, B) || inside(B, A)) continue;

        // Try every way out and take the smallest: either panel, either axis, keeping
        // the side each is already on so the model's arrangement survives. Moving one
        // down may be impossible where moving the other up is trivial, and giving up
        // on the first blocked direction is what left overlaps behind.
        const options = [];
        for (const [k, rMe, rOther] of [[idx[n].i, B, A], [idx[m].i, A, B]]) {
          for (const horizontal of [ox <= oy, ox > oy]) {
            const push = (horizontal ? ox : oy) + GAP;
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
              const hit = r[0] < o[0] + o[2] && o[0] < r[0] + r[2] && r[1] < o[1] + o[3] && o[1] < r[1] + r[3];
              return hit && !inside(r, o) && !inside(o, r);
            });
          });
        if (!clear) continue; // boxed in; the model has to redraw this one
        out[clear.k] = { ...out[clear.k], [clear.key]: out[clear.k][clear.key] + clear.delta };
        moved = true;
      }
    }
    if (!moved) break;
    if (pass === 0) repairs.push(`[${beat}] pushed overlapping panels apart`);
  }
  return out;
}

// The point on a segment closest to p — where a misplaced shield should have been.
function closestPoint(p, l) {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - l.x1) * dx + (p.y - l.y1) * dy) / len2)) : 0;
  return { x: l.x1 + t * dx, y: l.y1 + t * dy };
}

/** Every finding against a diagram spec paired with its beats — empty means render. */
export function lintDiagrams(spec, beats) {
  if (!Array.isArray(spec)) return ['[shape] expected an array of {beat, diagram} entries'];
  const findings = [];
  const add = (beat, msg) => findings.push(`[${beat}] ${msg}`);

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
            if (touch && !inside(me, p) && !inside(p, me)) add(b.name, `panels "${s.id}" and "${p[4]}" overlap`);
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
        if (tw.length > 4) add(b.name, `"${s.id}": label "${text}" is ${tw.length} words — keep it to 4`);
        if (tw.length >= 3 && said.includes(' ' + tw.join(' ') + ' ')) {
          add(b.name, `"${s.id}": label "${text}" repeats the narration — labels name parts, the caption says the sentence`);
        }
      }
    }

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

    const anims = e.diagram.anims || [];
    for (const a of anims) if (!ids.has(a.target)) add(b.name, `anim targets unknown shape "${a.target}"`);
    if (anims.length && Math.min(...anims.map((a) => a.at ?? 0)) > 0.4) {
      add(b.name, 'nothing appears in the first 0.4s — the diagram must assemble with the narration');
    }
  });

  return findings;
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

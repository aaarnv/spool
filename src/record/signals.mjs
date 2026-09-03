// Capture writes one continuous take plus this signal log, both on the video clock.
// Step boundaries are DERIVED from the log rather than baked into the recording, so a
// bad cut is re-derived from the same take instead of re-recorded (see `spool recut`).

// A navigation this soon after a click belongs to that click. The click is the action
// a viewer remembers, so the cut lands on it and swallows the load that follows.
const NAV_ATTRIB_S = 1.5;

// Two cuts closer than this are one beat, and a step this short reads as a flicker.
export const MIN_STEP_S = 2.5;

// How long the network must stay quiet before the take is called settled.
const QUIET_MS = 500;

/**
 * Record capture signals on the video clock.
 *
 * `now()` returns seconds since video t=0, so every signal shares the clock the
 * timeline and the renderer already use.
 */
export function createSignalRecorder({ now, quietMs = QUIET_MS } = {}) {
  const signals = [];
  const log = (sig) => {
    const entry = { t: +now().toFixed(3), ...sig };
    signals.push(entry);
    return entry;
  };

  let inflight = 0;
  let timer = null;
  let quiet = true;

  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      timer = null;
      if (inflight === 0 && !quiet) {
        quiet = true;
        log({ kind: 'settle' });
      }
    }, quietMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  function attach(page) {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      log({ kind: 'navigated', url: frame.url() });
    });
    page.on('request', () => {
      inflight++;
      quiet = false;
      disarm();
    });
    const done = () => {
      inflight = Math.max(0, inflight - 1);
      if (inflight === 0) arm();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }

  return { signals, log, attach, close: disarm };
}

export const serializeSignals = (signals) =>
  signals.map((s) => JSON.stringify(s)).join('\n') + (signals.length ? '\n' : '');

export const parseSignals = (text) =>
  String(text || '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const kebab = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function nameFromUrl(url) {
  let pathname = '/';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = String(url || '/');
  }
  const slug = kebab(pathname.split('/').filter(Boolean).slice(-2).join('-'));
  return slug ? `open-${slug}` : 'open-home';
}

function nameFromClick(sig) {
  const label = kebab(String(sig.text || '').split(/\s+/).slice(0, 4).join(' '));
  if (label) return `click-${label}`;
  const sel = kebab(String(sig.target || '').replace(/[#.[\]"'=]/g, ' '));
  return sel ? `click-${sel}` : 'click';
}

function uniqueNames(steps) {
  const seen = new Map();
  for (const s of steps) {
    const n = seen.get(s.name) || 0;
    seen.set(s.name, n + 1);
    if (n) s.name = `${s.name}-${n + 1}`;
  }
  return steps;
}

/**
 * Derive step boundaries from a signal log.
 *
 * Cuts come from three places: an explicit marker, a click that causes a navigation,
 * and a navigation nothing clicked for. Markers always survive; an inferred cut too
 * close to the one before it is folded into it.
 */
export function inferSteps(signals, { total, minStep = MIN_STEP_S } = {}) {
  const list = [...signals].sort((a, b) => a.t - b.t);
  const navs = list.filter((s) => s.kind === 'navigated');
  const clicks = list.filter((s) => s.kind === 'click');

  const claimed = new Set();
  const cuts = [];

  for (const c of clicks) {
    const nav = navs.find((n) => n.t >= c.t && n.t - c.t <= NAV_ATTRIB_S && !claimed.has(n));
    if (!nav) continue;
    claimed.add(nav);
    cuts.push({ t: c.t, name: nameFromClick(c), source: 'click-nav', marker: false });
  }
  for (const n of navs) {
    if (claimed.has(n)) continue;
    cuts.push({ t: n.t, name: nameFromUrl(n.url), source: 'nav', marker: false });
  }
  for (const m of list.filter((s) => s.kind === 'marker')) {
    cuts.push({
      t: m.t,
      name: kebab(m.name) || 'step',
      ...(m.chapterId ? { chapterId: m.chapterId } : {}),
      ...(m.narration ? { narration: m.narration } : {}),
      source: 'marker',
      marker: true,
    });
  }

  cuts.sort((a, b) => a.t - b.t || Number(b.marker) - Number(a.marker));

  const kept = [];
  for (const cut of cuts) {
    const prev = kept[kept.length - 1];
    // minStep folds cuts nobody asked for. A marker is an instruction, so it is kept
    // however close it lands, and it renames an inferred cut it is standing on.
    if (!prev || cut.marker || cut.t - prev.t >= minStep) {
      if (prev && cut.marker && !prev.marker && cut.t - prev.t < minStep) {
        prev.name = cut.name;
        prev.marker = true;
        prev.source = 'marker';
        if (cut.chapterId) prev.chapterId = cut.chapterId;
        if (cut.narration) prev.narration = cut.narration;
        continue;
      }
      kept.push(cut);
    }
  }

  const first = navs[0];
  if (!kept.length) {
    kept.push({ t: 0, name: first ? nameFromUrl(first.url) : 'open', source: 'start', marker: false });
  } else if (kept[0].t >= minStep) {
    kept.unshift({ t: 0, name: first ? nameFromUrl(first.url) : 'open', source: 'start', marker: false });
  } else {
    // The first cut lands close enough to the top that it IS the opener; a synthetic
    // start before it would only add a sliver nobody can read.
    kept[0].t = 0;
  }

  const end = typeof total === 'number' ? total : (list[list.length - 1]?.t ?? 0);
  const steps = kept.map((cut, i) => {
    const start = +cut.t.toFixed(3);
    const stop = +(i + 1 < kept.length ? kept[i + 1].t : end).toFixed(3);
    return {
      i,
      name: cut.name,
      ...(cut.chapterId ? { chapterId: cut.chapterId } : {}),
      ...(cut.narration ? { narration: cut.narration } : {}),
      start,
      end: stop,
      zoom: 'none',
      clicks: clicks
        .filter((c) => c.t >= start && c.t < stop)
        .map((c) => ({ x: c.x, y: c.y, t: c.t })),
      source: cut.source,
    };
  });

  // A trailing sliver is the tail of the step before it, not a beat of its own. A
  // marker is never a sliver: someone asked for that boundary by name.
  if (steps.length > 1) {
    const last = steps[steps.length - 1];
    if (last.end - last.start < minStep && !last.narration && last.source !== 'marker') {
      const prev = steps[steps.length - 2];
      prev.end = last.end;
      prev.clicks = prev.clicks.concat(last.clicks);
      steps.pop();
    }
  }

  return uniqueNames(steps).map((s, i) => ({ ...s, i }));
}

const joinNarration = (a, b) => [a, b].filter(Boolean).join(' ').trim() || undefined;

/**
 * Hand edits on top of the inferred cut. Each op names a step by index against the
 * list as it stands when the op runs, so a sequence reads left to right.
 */
export function applyCutOps(steps, ops = []) {
  let out = steps.map((s) => ({ ...s, clicks: [...s.clicks] }));
  const at = (i, op) => {
    if (!Number.isInteger(i) || i < 0 || i >= out.length) {
      throw new Error(`${op}: step ${i} is out of range (0..${out.length - 1})`);
    }
    return out[i];
  };

  for (const op of ops) {
    if (op.op === 'merge') {
      const s = at(op.i, 'merge');
      if (op.i === 0) throw new Error('merge: step 0 has nothing before it to merge into');
      const prev = out[op.i - 1];
      prev.end = s.end;
      prev.clicks = prev.clicks.concat(s.clicks);
      const n = joinNarration(prev.narration, s.narration);
      if (n) prev.narration = n;
      out.splice(op.i, 1);
    } else if (op.op === 'split') {
      const s = at(op.i, 'split');
      if (!(op.at > s.start && op.at < s.end)) {
        throw new Error(`split: ${op.at}s is outside step ${op.i} (${s.start}s..${s.end}s)`);
      }
      const tail = {
        ...s,
        name: `${s.name}-b`,
        start: +op.at.toFixed(3),
        end: s.end,
        clicks: s.clicks.filter((c) => c.t >= op.at),
        source: 'manual',
      };
      delete tail.narration;
      s.end = +op.at.toFixed(3);
      s.clicks = s.clicks.filter((c) => c.t < op.at);
      out.splice(op.i + 1, 0, tail);
    } else if (op.op === 'name') {
      at(op.i, 'name').name = kebab(op.name) || 'step';
    } else if (op.op === 'chapter') {
      at(op.i, 'chapter').chapterId = op.chapterId;
    } else if (op.op === 'narrate') {
      at(op.i, 'narrate').narration = op.text;
    } else if (op.op === 'drop') {
      at(op.i, 'drop');
      if (out.length === 1) throw new Error('drop: a take needs at least one step');
      // Each window slices the video from its own start, so a dropped step leaves a
      // hole in the take and its footage never reaches the output. That is the trim.
      out.splice(op.i, 1);
    } else if (op.op === 'trim') {
      const s = at(op.i, 'trim');
      if (!(op.at > s.start && op.at < s.end)) {
        throw new Error(`trim: ${op.at}s is outside step ${op.i} (${s.start}s..${s.end}s)`);
      }
      s[op.side === 'end' ? 'end' : 'start'] = +op.at.toFixed(3);
      s.clicks = s.clicks.filter((c) => c.t >= s.start && c.t < s.end);
    } else {
      throw new Error(`unknown cut op: ${JSON.stringify(op.op)}`);
    }
  }

  return uniqueNames(out).map((s, i) => ({ ...s, i }));
}

/** Parse `--merge 2`, `--split 1@8.5`, `--name 0=intro`, `--chapter 1=approach`. */
export function parseCutOps(argv = {}) {
  const ops = [];
  const num = (v, flag) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${flag}: expected a number, got ${JSON.stringify(v)}`);
    return n;
  };
  for (const v of argv.merge || []) ops.push({ op: 'merge', i: num(v, '--merge') });
  for (const v of argv.drop || []) ops.push({ op: 'drop', i: num(v, '--drop') });
  for (const [flag, side] of [['trimStart', 'start'], ['trimEnd', 'end']]) {
    for (const v of argv[flag] || []) {
      const [i, t] = String(v).split('@');
      if (t === undefined) throw new Error(`--trim-${side}: expected <step>@<seconds>, got ${JSON.stringify(v)}`);
      ops.push({ op: 'trim', side, i: num(i, `--trim-${side}`), at: num(t, `--trim-${side}`) });
    }
  }
  for (const v of argv.split || []) {
    const [i, t] = String(v).split('@');
    if (t === undefined) throw new Error(`--split: expected <step>@<seconds>, got ${JSON.stringify(v)}`);
    ops.push({ op: 'split', i: num(i, '--split'), at: num(t, '--split') });
  }
  for (const [flag, op, key] of [
    ['name', 'name', 'name'],
    ['chapter', 'chapter', 'chapterId'],
    ['narrate', 'narrate', 'text'],
  ]) {
    for (const v of argv[flag] || []) {
      const eq = String(v).indexOf('=');
      if (eq < 0) throw new Error(`--${flag}: expected <step>=<value>, got ${JSON.stringify(v)}`);
      ops.push({ op, i: num(String(v).slice(0, eq), `--${flag}`), [key]: String(v).slice(eq + 1) });
    }
  }
  return ops;
}

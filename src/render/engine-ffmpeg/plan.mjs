// Plan Spool card layer: the six card types as plain HTML. The reveal runs off the
// ABSOLUTE frame, so only the chapter live at frame 0 ever animates and every later
// chapter is drawn already revealed.
import { join } from "node:path";
import { activePlanVisual, planStageLayout } from "../plan/model.mjs";
import { getPlanTheme } from "../plan/themes.mjs";
import { esc, writeConcat } from "./assets.mjs";
import { framesToSpans } from "./expr.mjs";
import { easeOutCubic, interp } from "./scene.mjs";

const TYPE_LABELS = {
  context: "Context",
  outcome: "Outcome",
  sequence: "Sequence",
  risks: "Risks and assumptions",
  decision: "Decision request",
  evidence: "Evidence attribution",
};

// Font stacks quote family names; a double quote would close the style attribute.
const f = (s) => String(s).replace(/"/g, "'");

function revealCss(frame, theme, delay = 0) {
  const progress = interp(frame, [delay, delay + theme.motion.durationFrames], [0, 1], easeOutCubic);
  if (theme.motion.reveal === "scan")
    return `opacity:${progress};clip-path:inset(0 ${100 - progress * 100}% 0 0)`;
  if (theme.motion.reveal === "lift")
    return `opacity:${progress};transform:translateY(${theme.motion.entryY * (1 - progress)}px) scale(${0.97 + progress * 0.03})`;
  return `opacity:${progress};transform:translateX(${-theme.motion.entryY * (1 - progress)}px)`;
}

function directionDetail(theme) {
  if (theme.id === "technical-system")
    return `<div style="position:absolute;inset:0;opacity:0.2;background-image:linear-gradient(${theme.color.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.color.line} 1px, transparent 1px);background-size:44px 44px"></div>
      <div style="position:absolute;top:18px;right:20px;color:${theme.color.accent};font-family:${f(theme.font.mono)};font-size:13px;letter-spacing:0.14em">READY</div>`;
  if (theme.id === "warm-briefing")
    return `<div style="position:absolute;width:260px;height:260px;right:-90px;top:-100px;border-radius:50%;background:${theme.color.accent};opacity:0.11"></div>
      <div style="position:absolute;width:190px;height:190px;left:-100px;bottom:-100px;border-radius:50%;background:${theme.color.assumption};opacity:0.09"></div>`;
  return `<div style="position:absolute;left:0;top:0;bottom:0;width:8px;background:${theme.color.accent}"></div>`;
}

function header(card, theme, compact, frame) {
  return `<div style="position:relative;${revealCss(frame, theme)}">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
      <div style="color:${theme.color.accent};font-family:${f(theme.font.mono)};font-size:${compact ? 13 : 17}px;font-weight:700;letter-spacing:0.13em;text-transform:uppercase">${esc(TYPE_LABELS[card.type] || card.type)}</div>
      <div style="height:1px;flex:1;max-width:${compact ? 86 : 220}px;background:${theme.color.line}"></div>
    </div>
    <div style="margin-top:${compact ? 14 : 22}px;color:${theme.color.text};font-family:${f(theme.font.display)};font-size:${compact ? 34 : 58}px;font-weight:${theme.id === "editorial-minimal" ? 500 : 700};line-height:1.02;letter-spacing:${theme.id === "technical-system" ? "-0.045em" : "-0.035em"}">${esc(card.title)}</div>
  </div>`;
}

const label = (text, theme, compact, color) =>
  `<div style="color:${color || theme.color.mutedText};font-family:${f(theme.font.mono)};font-size:${compact ? 12 : 15}px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase">${esc(text)}</div>`;

function listItem(text, theme, compact, frame, index, marker = "•", markerColor) {
  return `<div style="${revealCss(frame, theme, 6 + index * theme.motion.staggerFrames)};display:grid;grid-template-columns:${compact ? "24px" : "34px"} 1fr;gap:${compact ? 8 : 12}px;color:${theme.color.text};font-family:${f(theme.font.body)};font-size:${compact ? 19 : 27}px;line-height:1.28">
    <div style="color:${markerColor || theme.color.accent};font-family:${f(theme.font.mono)};font-weight:800">${marker}</div>
    <div>${esc(text)}</div>
  </div>`;
}

function riskGroup(title, items, theme, compact, frame, color, offset) {
  const body = items.length
    ? items
        .map((item, i) =>
          listItem(item, theme, compact, frame, offset + i, title === "Risks" ? "!" : "◇", color)
        )
        .join("")
    : `<div style="color:${theme.color.mutedText};font-family:${f(theme.font.body)}">None stated.</div>`;
  return `<div style="display:grid;align-content:start;gap:${compact ? 12 : 17}px">${label(title, theme, compact, color)}${body}</div>`;
}

const BODY = {
  context: (card, theme, compact, frame) =>
    `<div style="display:grid;gap:${compact ? 20 : 30}px">
      <div style="${revealCss(frame, theme, 4)};padding:${compact ? 16 : 22}px;border-radius:${theme.radius.item}px;background:${theme.color.surfaceAlt}">
        ${label("Goal", theme, compact)}
        <div style="margin-top:8px;color:${theme.color.text};font-family:${f(theme.font.body)};font-size:${compact ? 21 : 31}px;line-height:1.25;font-weight:650">${esc(card.goal)}</div>
      </div>
      <div style="display:grid;gap:${compact ? 13 : 18}px">${card.claims.map((c, i) => listItem(c, theme, compact, frame, i)).join("")}</div>
    </div>`,

  outcome: (card, theme, compact, frame) =>
    `<div style="${revealCss(frame, theme, 5)};display:grid;align-content:center;min-height:${compact ? 250 : 390}px">
      ${label("Success looks like", theme, compact)}
      <div style="margin-top:${compact ? 18 : 28}px;color:${theme.color.text};font-family:${f(theme.font.display)};font-size:${compact ? 34 : 62}px;font-weight:${theme.id === "editorial-minimal" ? 500 : 700};line-height:1.08;letter-spacing:-0.035em">${esc(card.statement)}</div>
      <div style="margin-top:${compact ? 22 : 34}px;width:${compact ? 72 : 110}px;height:5px;border-radius:5px;background:${theme.color.accent}"></div>
    </div>`,

  sequence: (card, theme, compact, frame) =>
    `<div style="display:grid;gap:${compact ? 10 : 14}px">${card.steps
      .map(
        (step, i) => `<div style="${revealCss(frame, theme, 5 + i * theme.motion.staggerFrames)};display:grid;grid-template-columns:${compact ? "42px" : "58px"} 1fr;gap:${compact ? 12 : 18}px;align-items:center;padding:${compact ? "14px 15px" : "19px 22px"};border-radius:${theme.radius.item}px;background:${theme.color.surfaceAlt};border:${theme.border.width}px ${theme.border.style} ${theme.color.line}">
          <div style="display:grid;place-items:center;width:${compact ? 38 : 52}px;height:${compact ? 38 : 52}px;border-radius:${theme.radius.pill}px;background:${theme.color.accent};color:${theme.color.accentText};font-family:${f(theme.font.mono)};font-size:${compact ? 15 : 20}px;font-weight:800">${String(step.number).padStart(2, "0")}</div>
          <div style="color:${theme.color.text};font-family:${f(theme.font.body)};font-size:${compact ? 19 : 27}px;line-height:1.22;font-weight:650">${esc(step.label)}</div>
        </div>`
      )
      .join("")}</div>`,

  risks: (card, theme, compact, frame) =>
    `<div style="display:grid;grid-template-columns:${compact ? "1fr" : "1fr 1fr"};gap:${compact ? 25 : 42}px">
      ${riskGroup("Risks", card.risks, theme, compact, frame, theme.color.risk, 0)}
      ${riskGroup("Assumptions", card.assumptions, theme, compact, frame, theme.color.assumption, card.risks.length)}
    </div>`,

  decision: (card, theme, compact, frame) =>
    `<div style="display:grid;gap:${compact ? 18 : 26}px">
      <div style="${revealCss(frame, theme, 4)};color:${theme.color.text};font-family:${f(theme.font.display)};font-size:${(compact ? 28 : 48) * theme.decision.promptScale}px;font-weight:750;line-height:1.12;letter-spacing:-0.025em">${esc(card.prompt)}</div>
      <div style="display:grid;gap:${compact ? 10 : 13}px">${card.options
        .map((option, i) => {
          const fill = i === 0 && theme.decision.optionFill;
          return `<div style="${revealCss(frame, theme, 8 + i * theme.motion.staggerFrames)};display:flex;align-items:center;gap:${compact ? 11 : 16}px;padding:${compact ? "13px 15px" : "17px 20px"};border-radius:${theme.radius.item}px;color:${fill ? theme.color.accentText : theme.color.text};background:${fill ? theme.color.accent : theme.color.surfaceAlt};border:${Math.max(1, theme.border.width)}px solid ${i === 0 ? theme.color.accent : theme.color.line};font-family:${f(theme.font.body)};font-size:${compact ? 18 : 25}px;line-height:1.2;font-weight:700;text-transform:${theme.decision.uppercase ? "uppercase" : "none"};letter-spacing:${theme.decision.uppercase ? "0.04em" : "0"}">
            <span style="font-family:${f(theme.font.mono)};opacity:0.78">${String(i + 1).padStart(2, "0")}</span>
            <span>${esc(option.label)}</span>
          </div>`;
        })
        .join("")}</div>
    </div>`,

  evidence: (card, theme, compact, frame) =>
    `<div style="display:grid;gap:${compact ? 11 : 16}px">${card.items
      .map(
        (item, i) => `<div style="${revealCss(frame, theme, 5 + i * theme.motion.staggerFrames)};padding:${compact ? 14 : 20}px;border-radius:${theme.radius.item}px;background:${theme.color.surfaceAlt};border:${theme.border.width}px ${theme.border.style} ${theme.color.line}">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
            <div style="color:${theme.color.text};font-family:${f(theme.font.body)};font-size:${compact ? 18 : 25}px;line-height:1.22;font-weight:700">${esc(item.label)}</div>
            <div style="flex-shrink:0;padding:${compact ? "5px 8px" : "7px 10px"};border-radius:${theme.radius.pill}px;color:${theme.color.accentText};background:${theme.color.accent};font-family:${f(theme.font.mono)};font-size:${compact ? 10 : 13}px;font-weight:800;text-transform:uppercase">${esc(item.kind)}</div>
          </div>
          <div style="margin-top:${compact ? 8 : 11}px;color:${theme.color.mutedText};font-family:${f(theme.font.mono)};font-size:${compact ? 13 : 17}px;line-height:1.25;overflow-wrap:anywhere">${esc(item.ref)}</div>
        </div>`
      )
      .join("")}</div>`,
};

export function planCardHtml({ card, theme, compact, frame }) {
  const body = BODY[card.type];
  if (!body) throw new Error(`unknown plan card type "${card.type}"`);
  return `<div style="position:relative;width:100%;height:100%;box-sizing:border-box;overflow:hidden;display:grid;grid-template-rows:auto 1fr;gap:${compact ? 26 : 42}px;padding:${compact ? 30 : 58}px;border-radius:${theme.radius.card}px;border:${theme.border.width}px ${theme.border.style} ${theme.color.line};background:${theme.color.surface};box-shadow:${theme.shadow}">
    ${directionDetail(theme)}
    ${header(card, theme, compact, frame)}
    <div style="position:relative;min-height:0;align-self:stretch">${body(card, theme, compact, frame)}</div>
  </div>`;
}

function evidencePillHtml(item, theme) {
  return `<div style="display:flex;align-items:center;gap:9px;max-width:100%;padding:8px 11px;border-radius:${theme.radius.pill}px;color:${theme.color.text};background:${theme.color.surface};border:1px solid ${theme.color.line};box-shadow:${theme.shadow};font-family:${f(theme.font.body)};font-size:13px">
    <span style="color:${theme.color.accent};font-family:${f(theme.font.mono)};font-weight:800;text-transform:uppercase">${esc(item.kind)}</span>
    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.label)}</span>
  </div>`;
}

/** The full-canvas plan overlay: the chapter's card plus its evidence pill. */
export function planLayerHtml({ card, theme, layout, frame, compact, evidence }) {
  const top = layout.card.y + layout.card.height + (layout.orientation === "portrait" ? 18 : 12);
  const pill = evidence
    ? `<div style="position:absolute;left:${layout.card.x}px;top:${top}px;width:${layout.card.width}px;display:flex;justify-content:${layout.orientation === "portrait" ? "center" : "flex-start"}">${evidencePillHtml(evidence, theme)}</div>`
    : "";
  return `<div style="position:absolute;left:${layout.card.x}px;top:${layout.card.y}px;width:${layout.card.width}px;height:${layout.card.height}px">${planCardHtml({ card, theme, compact, frame })}</div>${pill}`;
}

/** The plan canvas, which replaces the wallpaper entirely. */
export function planBgHtml(theme) {
  const bg =
    theme.id === "editorial-minimal"
      ? `linear-gradient(135deg, ${theme.color.canvas} 0%, ${theme.color.canvasDetail} 180%)`
      : `radial-gradient(circle at 82% 12%, ${theme.color.canvasDetail} 0%, ${theme.color.canvas} 58%)`;
  return `<div style="position:absolute;inset:0;background:${bg}"></div>`;
}

// Last frame on which anything is still animating. Past it a card is static, so the
// whole rest of the take collapses to one state per chapter.
export function cardRevealEnd(card, theme) {
  const items =
    (card.claims?.length ?? 0) ||
    (card.steps?.length ?? 0) ||
    (card.risks?.length ?? 0) + (card.assumptions?.length ?? 0) ||
    (card.options?.length ?? 0) ||
    (card.items?.length ?? 0) ||
    1;
  return theme.motion.durationFrames + 8 + Math.max(0, items - 1) * theme.motion.staggerFrames;
}

/**
 * Per-frame plan state, deduplicated. Chapters are long and the reveal is short, so
 * this collapses to a handful of states plus the opening animation.
 */
export function planStates({ cards, script, windows, timeline, frames, fps, canvasW, canvasH, theme }) {
  const seen = new Map();
  const states = [];
  const runs = [];
  const overlayFrames = [];
  const layoutCache = new Map();
  const layoutFor = (mode) => {
    if (!layoutCache.has(mode)) layoutCache.set(mode, planStageLayout({ width: canvasW, height: canvasH, mode }));
    return layoutCache.get(mode);
  };
  let run = null;
  const modeByFrame = new Array(frames);
  for (let i = 0; i < frames; i++) {
    const st = activePlanVisual({ cards, script, windows, timeline, time: i / fps });
    const layout = layoutFor(st.mode);
    const evidence = st.evidence?.[0] || null;
    modeByFrame[i] = st.mode;
    if (st.mode === "overlay") overlayFrames.push(i);
    const revealFrame = st.card ? Math.min(i, cardRevealEnd(st.card, theme)) : 0;
    const key = st.card ? `${st.card.id}:${st.mode}:${evidence?.id || ""}:${revealFrame}` : "e";
    let idx = seen.get(key);
    if (idx === undefined) {
      idx = states.length;
      seen.set(key, idx);
      states.push(st.card ? { card: st.card, mode: st.mode, layout, evidence, frame: revealFrame } : null);
    }
    if (run && run.idx === idx) run.frames++;
    else {
      if (run) runs.push(run);
      run = { idx, frames: 1 };
    }
  }
  if (run) runs.push(run);
  return {
    states,
    runs,
    modeByFrame,
    mediaSpans: framesToSpans(overlayFrames, fps),
    layouts: [...layoutCache.entries()].map(([mode, layout]) => ({ mode, layout })),
    overlayLayout: layoutFor("overlay"),
  };
}

/** Rasterise the card layer to `dir` and write its concat list. */
export async function renderPlanLayer({ browser, dir, canvasW, canvasH, theme, states, runs, fps, concurrency = 4 }) {
  const name = (i) => `plan_${String(i).padStart(4, "0")}.png`;
  const lanes = Math.max(1, Math.min(concurrency, states.length));
  const pages = [];
  for (let i = 0; i < lanes; i++) {
    pages.push(await browser.newPage({ viewport: { width: canvasW, height: canvasH }, deviceScaleFactor: 1 }));
  }
  await Promise.all(
    pages.map(async (p, lane) => {
      for (let i = lane; i < states.length; i += lanes) {
        const s = states[i];
        const body = s
          ? planLayerHtml({
              card: s.card,
              theme,
              layout: s.layout,
              frame: s.frame,
              compact: s.mode === "overlay",
              evidence: s.evidence,
            })
          : "";
        await p.setContent(`<body style="margin:0;background:transparent;overflow:hidden">${body}</body>`, {
          waitUntil: "load",
        });
        await p.screenshot({ path: join(dir, name(i)), omitBackground: true });
      }
    })
  );
  await Promise.all(pages.map((p) => p.close()));
  const list = await writeConcat(
    dir,
    "plan.txt",
    runs.map((r) => ({ file: name(r.idx), dur: r.frames / fps }))
  );
  return { list, states: states.length };
}

export { getPlanTheme, planStageLayout };

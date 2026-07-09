// Overlay cursor + smooth-motion helpers for the record layer.
// The real OS pointer is invisible in Playwright's headless capture, so we draw
// our own: an init script paints a macOS-style arrow that tracks the synthetic
// mouse events page.mouse.* dispatches, and makeHelpers drives that mouse with
// human-speed motion while logging clicks for the timeline.

// Injected via context.addInitScript — re-runs on every new document (full loads
// and the initial page of an SPA), so it must be self-contained and idempotent.
export const CURSOR_INIT_SCRIPT = `(() => {
  if (window.__spoolCursor) return;
  window.__spoolCursor = { x: -100, y: -100 };

  let root = null, arrow = null;

  function build() {
    if (!document.body || document.getElementById('__spoolCursorRoot')) return;
    root = document.createElement('div');
    root.id = '__spoolCursorRoot';
    root.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;margin:0;padding:0;z-index:2147483647;pointer-events:none;';

    arrow = document.createElement('div');
    arrow.style.cssText = 'position:absolute;left:0;top:0;width:24px;height:24px;will-change:transform;';
    // macOS-style pointer: tip at (2,1) is the hotspot, white fill + black outline.
    arrow.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" style="display:block;overflow:visible;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.4));"><path d="M2,1 L2,20 L7,15.4 L10.1,22.3 L13,21 L9.9,14.2 L16,14.2 Z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    root.appendChild(arrow);
    document.body.appendChild(root);

    const p = window.__spoolCursor;
    arrow.style.transform = 'translate3d(' + (p.x - 1) + 'px,' + (p.y - 1) + 'px,0)';
  }

  function ripple(x, y) {
    if (!root) return;
    const r = document.createElement('div');
    r.style.cssText = 'position:absolute;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2px solid rgba(40,120,255,.9);box-sizing:border-box;pointer-events:none;transform:translate3d(' + x + 'px,' + y + 'px,0) scale(.3);opacity:.9;transition:transform .35s ease-out,opacity .35s ease-out;';
    root.appendChild(r);
    requestAnimationFrame(() => {
      r.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) scale(2.6)';
      r.style.opacity = '0';
    });
    setTimeout(() => { r.remove(); }, 380);
  }

  // Listen in the capture phase so page handlers can't stop us seeing the event.
  document.addEventListener('mousemove', (e) => {
    window.__spoolCursor.x = e.clientX;
    window.__spoolCursor.y = e.clientY;
    if (arrow) arrow.style.transform = 'translate3d(' + (e.clientX - 1) + 'px,' + (e.clientY - 1) + 'px,0)';
  }, true);
  document.addEventListener('mousedown', (e) => { ripple(e.clientX, e.clientY); }, true);

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();`;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Returns the `h` API handed to steps. `state` holds the last cursor coords so
// motion stays continuous across steps; logClick records viewport-space clicks.
export function makeHelpers(page, state, logClick) {
  // Re-assert the pointer after any main-frame navigation: a fresh document
  // starts with the overlay offscreen until it sees a mousemove, so nudge it
  // back to where the cursor logically is.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      page.mouse.move(state.x, state.y).catch(() => {});
    }
  });

  async function move(x, y) {
    const dist = Math.hypot(x - state.x, y - state.y);
    const steps = Math.round(clamp(dist / 8, 12, 60));
    await page.mouse.move(x, y, { steps });
    state.x = x;
    state.y = y;
  }

  async function resolvePoint(target, who) {
    if (target && typeof target === 'object' && typeof target.x === 'number' && typeof target.y === 'number') {
      return { x: target.x, y: target.y }; // explicit point: caller owns the coords, no scroll
    }
    if (typeof target !== 'string') {
      throw new Error(`${who}: expected a selector string or {x,y}, got ${JSON.stringify(target)}`);
    }
    const locator = page.locator(target).first();

    // A boundingBox is viewport-relative, so a below-fold element resolves to a
    // point outside the viewport and the click would land on nothing. Scroll it
    // into view first — human-like via the eased wheel, then guarantee with
    // scrollIntoViewIfNeeded (a no-op when the wheel already did it, so no teleport).
    const vp = page.viewportSize() || { width: 1600, height: 900 };
    let box = await locator.boundingBox();
    if (box) {
      const fullyVisible = box.y >= 0 && box.y + box.height <= vp.height;
      if (!fullyVisible) {
        const centerY = box.y + box.height / 2;
        const dy = Math.round(centerY - vp.height * 0.45); // aim center to ~45% height
        if (Math.abs(dy) > 4) await scroll(dy);
      }
    }
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(120); // settle so the recording shows a natural stop, not a jump

    box = await locator.boundingBox();
    if (!box) throw new Error(`${who}: selector not found or not visible: ${target}`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (x < 0 || y < 0 || x > vp.width || y > vp.height) {
      throw new Error(`${who}: "${target}" center (${Math.round(x)},${Math.round(y)}) is still outside the ${vp.width}x${vp.height} viewport after scrolling`);
    }
    return { x, y };
  }

  async function click(target) {
    const { x, y } = await resolvePoint(target, 'click');
    await move(x, y);
    await page.waitForTimeout(60); // settle before pressing
    await page.mouse.down();
    await page.mouse.up();
    logClick(x, y);
  }

  async function type(selector, text) {
    await click(selector);
    await page.keyboard.type(text, { delay: 35 });
  }

  async function hover(target) {
    const { x, y } = await resolvePoint(target, 'hover');
    await move(x, y);
  }

  async function scroll(dy) {
    const n = 4 + Math.floor(Math.random() * 3); // 4-6 increments
    const weights = [];
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const w = Math.sin(((k + 0.5) / n) * Math.PI); // ease in/out
      weights.push(w);
      sum += w;
    }
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const part = Math.round((dy * weights[k]) / sum);
      acc += part;
      await page.mouse.wheel(0, part);
      await page.waitForTimeout(28);
    }
    if (acc !== dy) await page.mouse.wheel(0, dy - acc);
  }

  async function pause(ms) {
    await page.waitForTimeout(ms);
  }

  return { move, click, type, hover, scroll, pause };
}

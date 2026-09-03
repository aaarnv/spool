// GSAP eases as pure math, matched numerically against the vendored gsap.min.js.
// power3 is QUART in GSAP's naming (Power0=linear ... Power3=p^4), not cubic.
export const clamp01 = (x) => Math.max(0, Math.min(1, x));

export const easeBack = (p) => { const q = p - 1; return q * q * (2.9 * q + 1.9) + 1; };

export const easeElastic = (p) => (p === 1 ? 1
  : Math.pow(2, -10 * p) * Math.sin((p - 0.1) * (Math.PI * 2) / 0.4) + 1);

export const easePow = (p) => 1 - Math.pow(1 - p, 4);

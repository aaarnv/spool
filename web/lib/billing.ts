import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { billing } from "../db/schema";

// Billing lives in Postgres (billing table, ownerId PK). Stripe is the only
// writer of paid plans, via signed webhooks. No new deps: every Stripe call is a
// raw form-encoded fetch. Missing env is a caller concern — routes 503 cleanly.

const STRIPE_API = "https://api.stripe.com/v1";
const PAID_PLANS = new Set(["pro", "founder"]);

// True when the owner has an unexpired paid plan. A null currentPeriodEnd means
// perpetual (e.g. a founder grant); any set period must still be in the future.
export async function isPro(ownerId: string): Promise<boolean> {
  const [row] = await db.select().from(billing).where(eq(billing.ownerId, ownerId)).limit(1);
  if (!row || !PAID_PLANS.has(row.plan)) return false;
  if (row.currentPeriodEnd && row.currentPeriodEnd.getTime() <= Date.now()) return false;
  return true;
}

// Upsert only the provided fields (plus updatedAt). A brand-new row without an
// explicit plan falls to the column default 'free'.
export async function setPlan(
  ownerId: string,
  fields: { plan?: string; stripeCustomerId?: string; currentPeriodEnd?: Date | null }
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (fields.plan !== undefined) set.plan = fields.plan;
  if (fields.stripeCustomerId !== undefined) set.stripeCustomerId = fields.stripeCustomerId;
  if (fields.currentPeriodEnd !== undefined) set.currentPeriodEnd = fields.currentPeriodEnd;
  await db
    .insert(billing)
    .values({ ownerId, ...set })
    .onConflictDoUpdate({ target: billing.ownerId, set });
}

// Form-encoded POST to the Stripe REST API. Bracketed keys express nested params
// (e.g. "line_items[0][price]"). Throws with Stripe's error message on non-2xx.
export async function stripeRequest(
  path: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  const res = await fetch(`${STRIPE_API}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (data.error as { message?: string } | undefined)?.message;
    throw new Error(msg || `stripe ${path} failed: ${res.status}`);
  }
  return data;
}

// Verify a Stripe webhook signature by hand (no SDK). Parses the t=/v1= header,
// rejects a >5min timestamp skew, then constant-time compares HMAC-SHA256 of
// `${t}.${rawBody}`. Pure and unit-testable.
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  let t = "";
  let v1 = "";
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (k === "t") t = val;
    else if (k === "v1") v1 = val;
  }
  if (!t || !v1) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

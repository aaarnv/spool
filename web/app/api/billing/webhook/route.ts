import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { billing } from "../../../../db/schema";
import { setPlan, verifyStripeSignature } from "../../../../lib/billing";

export const runtime = "nodejs";

type StripeObject = {
  client_reference_id?: string | null;
  customer?: string | null;
  status?: string;
  current_period_end?: number | null;
  metadata?: { ownerId?: string } | null;
};

// Resolve the owner behind a subscription object: metadata is authoritative, else
// map the Stripe customer id back to our billing row.
async function ownerForSub(obj: StripeObject): Promise<string | null> {
  const metaOwner = obj.metadata?.ownerId;
  if (typeof metaOwner === "string" && metaOwner) return metaOwner;
  if (typeof obj.customer === "string" && obj.customer) {
    const [row] = await db
      .select({ ownerId: billing.ownerId })
      .from(billing)
      .where(eq(billing.stripeCustomerId, obj.customer))
      .limit(1);
    return row?.ownerId ?? null;
  }
  return null;
}

// Stripe webhook. Verifies the signature, then upserts plan state. Idempotent by
// construction (upserts). Any handled or ignored type returns 200 once the
// signature passes; a bad signature is 400.
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "billing not configured" }, { status: 503 });

  const raw = await req.text();
  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret)) {
    return Response.json({ error: "bad signature" }, { status: 400 });
  }

  let event: { type?: string; data?: { object?: StripeObject } };
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const obj = (event.data?.object ?? {}) as StripeObject;

  switch (event.type) {
    case "checkout.session.completed": {
      const ownerId = obj.client_reference_id;
      if (ownerId) await setPlan(ownerId, { plan: "pro", stripeCustomerId: obj.customer ?? undefined });
      break;
    }
    case "customer.subscription.updated": {
      const ownerId = await ownerForSub(obj);
      if (ownerId) {
        const active = obj.status === "active" || obj.status === "trialing";
        await setPlan(ownerId, {
          plan: active ? "pro" : "free",
          currentPeriodEnd: obj.current_period_end ? new Date(obj.current_period_end * 1000) : null,
        });
      }
      break;
    }
    case "customer.subscription.deleted": {
      const ownerId = await ownerForSub(obj);
      if (ownerId) await setPlan(ownerId, { plan: "free" });
      break;
    }
  }

  return Response.json({ received: true });
}

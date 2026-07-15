import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { billing } from "../../../../db/schema";
import { stripeRequest, setPlan } from "../../../../lib/billing";

export const runtime = "nodejs";

// Start a Pro subscription checkout. Reuses the owner's Stripe customer if one
// exists, else creates and persists it. The webhook flips the plan to pro.
export async function POST(req: Request) {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!process.env.STRIPE_SECRET_KEY || !priceId) {
    return Response.json({ error: "billing not configured" }, { status: 503 });
  }
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const origin = new URL(req.url).origin;
  const [row] = await db.select().from(billing).where(eq(billing.ownerId, userId)).limit(1);
  let customerId = row?.stripeCustomerId ?? null;
  if (!customerId) {
    const customer = await stripeRequest("customers", { "metadata[ownerId]": userId });
    customerId = String(customer.id);
    await setPlan(userId, { stripeCustomerId: customerId });
  }

  const session = await stripeRequest("checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: `${origin}/dashboard?billing=success`,
    cancel_url: `${origin}/dashboard?billing=cancelled`,
    client_reference_id: userId,
    customer: customerId,
    "subscription_data[metadata][ownerId]": userId,
  });
  return Response.json({ url: session.url });
}

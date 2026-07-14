import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { billing } from "../../../../db/schema";
import { stripeRequest } from "../../../../lib/billing";

export const runtime = "nodejs";

// Open the Stripe billing portal for the owner to manage/cancel their plan.
export async function POST(req: Request) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return Response.json({ error: "billing not configured" }, { status: 503 });
  }
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const [row] = await db.select().from(billing).where(eq(billing.ownerId, userId)).limit(1);
  if (!row?.stripeCustomerId) {
    return Response.json({ error: "no billing account" }, { status: 400 });
  }
  const origin = new URL(req.url).origin;
  const session = await stripeRequest("billing_portal/sessions", {
    customer: row.stripeCustomerId,
    return_url: `${origin}/dashboard`,
  });
  return Response.json({ url: session.url });
}

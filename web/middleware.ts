import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Everything is public except the dashboard: landing (/) and watch pages
// (/l/[id]) must stay reachable logged-out. /api/publish does its own bearer
// auth, so it is not gated here.
const isProtected = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};

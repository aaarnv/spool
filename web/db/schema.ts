import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  real,
  integer,
  boolean,
  jsonb,
  uuid,
  timestamp,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// One row per published spool. owner_id is a Clerk user id, or "aarnav-cli" for
// the legacy global token so existing CLI publishes still get indexed.
export const spools = pgTable(
  "spools",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    title: text("title"),
    duration: real("duration"),
    // True once the CLI has uploaded the render sources (see EDIT-CONTRACT.md);
    // only source-bearing spools are editable.
    hasSources: boolean("has_sources").notNull().default(false),
    // Project identity (server-derived from the PR url; NULL on non-PR/legacy
    // spools). Groups guides for the same GitHub repo into one shared project.
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    prNumber: integer("pr_number"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectIdx: index("spools_project_idx").on(t.ownerId, t.repoOwner, t.repoName),
  })
);

// One row per re-render request. Ops is the validated edit vocabulary (see
// EDIT-CONTRACT.md); the Fly worker claims queued rows and flips them running→done.
export const editJobs = pgTable(
  "edit_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spoolId: text("spool_id")
      .notNull()
      .references(() => spools.id),
    status: text("status").notNull().default("queued"), // queued | running | done | error
    instruction: text("instruction").notNull().default(""),
    ops: jsonb("ops").notNull(),
    error: text("error"),
    // Lease-based reliability: a claim stamps a fresh lease_token + expiry; a worker
    // heartbeats to extend it. An expired running lease is reclaimable (up to 3
    // attempts). lease_token is NULL only for jobs claimed before this feature.
    attempts: integer("attempts").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // At most one live (queued|running) job per spool, enforced in the DB so a
    // confirm race can't double-enqueue (the loser hits this and 409s).
    oneActivePerSpool: uniqueIndex("edit_jobs_one_active_per_spool")
      .on(t.spoolId)
      .where(sql`status in ('queued', 'running')`),
  })
);

// Per-user publish tokens. Only the SHA-256 hash is stored; the raw token is
// shown once at creation and never recoverable.
export const publishTokens = pgTable("publish_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  ownerId: text("owner_id").notNull(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Per-owner daily hosted-VO call counter, keyed by (owner_id, day) so the
// abuse cap is a single upserted counter row per day.
export const voUsage = pgTable(
  "vo_usage",
  {
    ownerId: text("owner_id").notNull(),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    count: integer("count").notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.day] }) })
);

// Per-spool public Q&A daily counters. The "*" ipHash row is the per-spool
// global counter; every other row is one requester IP for that day.
export const askUsage = pgTable(
  "ask_usage",
  {
    spoolId: text("spool_id").notNull(),
    ipHash: text("ip_hash").notNull(),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    count: integer("count").notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.spoolId, t.ipHash, t.day] }) })
);

// Per-repo daily bundle-miss counter. A miss is a public-ask file read the PR
// bundle couldn't answer: the tripwire signal that live repo access is needed.
export const bundleMisses = pgTable(
  "bundle_misses",
  {
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    count: integer("count").notNull().default(0), // total missed file-reads
    asks: integer("asks").notNull().default(0), // asks with >= 1 miss
    ownerId: text("owner_id").notNull(),
    lastSpoolId: text("last_spool_id"),
    lastPrNumber: integer("last_pr_number"),
    paths: jsonb("paths"), // recent missed paths, capped at 20
  },
  (t) => ({ pk: primaryKey({ columns: [t.repoOwner, t.repoName, t.day] }) })
);

// Per-project shared knowledge. Lives in Postgres, not Blob: the store is
// mutable read-modify-write state, and Blob's CDN serves stale reads after an
// in-place overwrite (and its URLs reject cache-busting query params).
export const projectKnowledge = pgTable(
  "project_knowledge",
  {
    ownerId: text("owner_id").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    store: jsonb("store").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.repoOwner, t.repoName] }) })
);

// One row per owner's billing state. Absent row = free plan. plan is 'free',
// 'pro' (paid subscription), or 'founder' (perpetual grant, null period). The
// publish gate reads this; Stripe webhooks are the only writers of paid plans.
export const billing = pgTable("billing", {
  ownerId: text("owner_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id"),
  plan: text("plan").notNull().default("free"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type SpoolRow = typeof spools.$inferSelect;
export type EditJobRow = typeof editJobs.$inferSelect;
export type BillingRow = typeof billing.$inferSelect;

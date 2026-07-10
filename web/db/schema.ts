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
} from "drizzle-orm/pg-core";

// One row per published spool. owner_id is a Clerk user id, or "aarnav-cli" for
// the legacy global token so existing CLI publishes still get indexed.
export const spools = pgTable("spools", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title"),
  duration: real("duration"),
  // True once the CLI has uploaded the render sources (see EDIT-CONTRACT.md);
  // only source-bearing spools are editable.
  hasSources: boolean("has_sources").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// One row per re-render request. Ops is the validated edit vocabulary (see
// EDIT-CONTRACT.md); the Fly worker claims queued rows and flips them running→done.
export const editJobs = pgTable("edit_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  spoolId: text("spool_id")
    .notNull()
    .references(() => spools.id),
  status: text("status").notNull().default("queued"), // queued | running | done | error
  instruction: text("instruction").notNull().default(""),
  ops: jsonb("ops").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

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

export type SpoolRow = typeof spools.$inferSelect;
export type EditJobRow = typeof editJobs.$inferSelect;

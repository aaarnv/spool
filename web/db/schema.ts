import { pgTable, text, real, timestamp } from "drizzle-orm/pg-core";

// One row per published spool. owner_id is a Clerk user id, or "aarnav-cli" for
// the legacy global token so existing CLI publishes still get indexed.
export const spools = pgTable("spools", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title"),
  duration: real("duration"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Per-user publish tokens. Only the SHA-256 hash is stored; the raw token is
// shown once at creation and never recoverable.
export const publishTokens = pgTable("publish_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  ownerId: text("owner_id").notNull(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type SpoolRow = typeof spools.$inferSelect;

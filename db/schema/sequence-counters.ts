import { pgTable, varchar, bigint, timestamp } from "drizzle-orm/pg-core";

/**
 * Durable sequence counters (migration 0002).
 *
 * The in-memory store kept these as plain numbers in DatabaseState
 * (`sequence_counters: { customer, order, invoice, subscription, license }`)
 * with base values 1000 / 10000 / 20000 / 30000 / 40000. Services increment
 * them inside withTransaction and format human numbers from them
 * (CUST-<n>, ORD-<n>, INV-<n>, SUB-<n>, LIC-<n>).
 *
 * One row per counter key. DrizzleStore reads all five rows on loadState()
 * (falling back to the in-memory base values for missing keys) and upserts
 * changed values inside the same transaction that incremented them, so a
 * number is never reused after a restart. On a database without migration
 * 0002 the store derives counters from the highest existing numbers in the
 * data and keeps them in memory only (see drizzle-store.ts).
 */
export const sequenceCounters = pgTable("sequence_counters", {
  counterKey: varchar("counter_key", { length: 40 }).primaryKey(),
  counterValue: bigint("counter_value", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

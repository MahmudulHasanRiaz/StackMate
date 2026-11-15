import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.ts";

/**
 * Staff invitations (API Spec §8, Batch 1).
 *
 * There is no email system, so an invitation is created by an admin and
 * its single-use token is returned ONCE to the admin, who shares it with
 * the invitee out of band. The invitee redeems it via
 * POST /api/auth/accept-invitation. Only the SHA-256 hash of the token is
 * stored — the raw token is never persisted (same rule as the
 * first-admin SETUP_TOKEN and license-key verifiers).
 *
 * status: pending | accepted | revoked | expired. Exactly one pending
 * invitation may exist per email (partial unique index); a new invitation
 * for the same email requires revoking/expiring the pending one first.
 */
export const staffInvitations = pgTable(
  "staff_invitations",
  {
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    roleKeys: jsonb("role_keys").notNull().default([]),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    acceptedUserId: text("accepted_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_staff_invitations_pending_email")
      .on(table.email)
      .where(sql`"staff_invitations"."status" = 'pending'`),
    index("idx_staff_invitations_token_hash").on(table.tokenHash),
    index("idx_staff_invitations_status").on(table.status),
  ]
);

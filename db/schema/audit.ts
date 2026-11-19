import { pgTable, uuid, varchar, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { integratedSites } from "./integrations.ts";

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey(),
    actorType: text("actor_type").notNull(), // staff | system | integration
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    integratedSiteId: uuid("integrated_site_id").references(() => integratedSites.id, {
      onDelete: "set null",
    }),
    action: varchar("action", { length: 120 }).notNull(),
    resourceType: varchar("resource_type", { length: 100 }).notNull(),
    resourceId: varchar("resource_id", { length: 100 }).notNull(),
    outcome: text("outcome").notNull(), // success | denied | failed
    requestId: varchar("request_id", { length: 100 }),
    ipHash: varchar("ip_hash", { length: 128 }),
    changes: jsonb("changes").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_audit_logs_resource").on(table.resourceType, table.resourceId, table.createdAt.desc()),
    index("idx_audit_logs_actor").on(table.actorUserId, table.createdAt.desc()),
    index("idx_audit_logs_action").on(table.action, table.createdAt.desc()),
  ]
);

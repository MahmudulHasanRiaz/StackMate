import { v } from "../common/validator.ts";
import { isValidIsoDateOnly } from "../common/dates.ts";

// Expense module — admin-recorded business expenses + P&L analytics.
//
// Money is integer minor units, BDT only (the expense contract fixes
// currency to 'BDT'; the P&L sales side is likewise BDT-scoped — see
// apps/api/src/modules/analytics/pnl.ts). Dates are ISO YYYY-MM-DD;
// instants are UTC ISO timestamps (ADR-0001).
//
// Permission keys (RBAC): the seed catalogue lives in
// db/seeds/seed-reference.ts (SEED_PERMISSIONS) and the seed + role
// grants for these keys are a DB-worker remainder — the service and
// routes already enforce them via assertStaffPermission, and the
// super_admin role bypasses the permission list, so the module works
// for super_admin/admin before the seed lands.

export const EXPENSE_PERMISSIONS = {
  read: "expenses.read",
  manage: "expenses.manage",
  categoriesManage: "expense_categories.manage",
} as const;

export const EXPENSE_CURRENCY = "BDT" as const;

/** Hex colour, e.g. "#00E599" (StackMate green default). */
const HexColorSchema = v
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "color must be a #RRGGBB hex value.");

const IsoDateOnlySchema = v
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD.")
  .refine((val) => isValidIsoDateOnly(val), "Date must be a valid calendar date.");

export const CreateExpenseCategorySchema = v.object({
  name: v.string().trim().min(1).max(120),
  description: v.string().trim().max(2000).nullable().optional(),
  color: HexColorSchema.optional().default("#00E599"),
  icon: v.string().trim().max(60).nullable().optional(),
  is_active: v.boolean().optional().default(true),
});

export const UpdateExpenseCategorySchema = v.object({
  name: v.string().trim().min(1).max(120).optional(),
  description: v.string().trim().max(2000).nullable().optional(),
  color: HexColorSchema.optional(),
  icon: v.string().trim().max(60).nullable().optional(),
  is_active: v.boolean().optional(),
});

export const CreateExpenseSchema = v.object({
  amountMinor: v.number().int().positive(),
  expenseDate: IsoDateOnlySchema,
  categoryId: v.string().uuid(),
  productId: v.string().uuid().nullable().optional(),
  paymentMethodId: v.string().uuid().nullable().optional(),
  vendor: v.string().trim().max(200).nullable().optional(),
  notes: v.string().trim().max(5000).nullable().optional(),
  receiptMediaId: v.string().uuid().nullable().optional(),
});

export const UpdateExpenseSchema = v.object({
  amountMinor: v.number().int().positive().optional(),
  expenseDate: IsoDateOnlySchema.optional(),
  categoryId: v.string().uuid().optional(),
  productId: v.string().uuid().nullable().optional(),
  paymentMethodId: v.string().uuid().nullable().optional(),
  vendor: v.string().trim().max(200).nullable().optional(),
  notes: v.string().trim().max(5000).nullable().optional(),
  receiptMediaId: v.string().uuid().nullable().optional(),
});

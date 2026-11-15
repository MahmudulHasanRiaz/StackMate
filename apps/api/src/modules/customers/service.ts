import { randomUUID } from "node:crypto";
import {
  CreateCustomerSchema,
  UpdateCustomerSchema,
} from "../../../../../packages/contracts/src/index.ts";
import type {
  CustomerRecord,
  DatabaseState,
  StackMateDataStore,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

export function normalizePhoneE164(rawPhone?: string | null): string | null {
  if (!rawPhone) return null;
  const digits = rawPhone.replace(/[^\d+]/g, "");
  if (digits.startsWith("01") && digits.length === 11) {
    return `+880${digits.slice(1)}`;
  }
  return digits.startsWith("+") ? digits : `+${digits}`;
}

export function createCustomerInTx(
  state: DatabaseState,
  input: {
    customer_type?: "person" | "business";
    name: string;
    email?: string | null;
    phone?: string | null;
    company_name?: string | null;
    country_code?: string;
    registration_source: string;
    notes?: string | null;
  }
): CustomerRecord {
  state.sequence_counters.customer += 1;
  const customerNumber = `CUST-${state.sequence_counters.customer}`;
  const now = new Date().toISOString();
  const normalizedEmail = input.email ? input.email.trim().toLowerCase() : null;
  const normalizedPhone = normalizePhoneE164(input.phone);

  const customer: CustomerRecord = {
    id: randomUUID(),
    customer_number: customerNumber,
    customer_type: input.customer_type ?? "person",
    name: input.name.trim(),
    email: input.email ? input.email.trim() : null,
    normalized_email: normalizedEmail,
    phone: input.phone ? input.phone.trim() : null,
    normalized_phone: normalizedPhone,
    company_name: input.company_name ? input.company_name.trim() : null,
    country_code: (input.country_code ?? "BD").toUpperCase(),
    status: "active",
    registration_source: input.registration_source,
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
  };
  state.customers.push(customer);
  return customer;
}

export async function createCustomerByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string
): Promise<CustomerRecord> {
  assertStaffPermission(actor, "customers.manage");
  const input = CreateCustomerSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const customer = createCustomerInTx(state, {
      customer_type: input.customer_type,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      company_name: input.company_name ?? null,
      country_code: input.country_code,
      registration_source: "admin",
      notes: input.notes ?? null,
    });

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "customers.customer.created",
      resource_type: "customer",
      resource_id: customer.id,
      outcome: "success",
      request_id: requestId,
      changes: { customer_number: customer.customer_number, country_code: customer.country_code },
    });

    return customer;
  });
}

export async function updateCustomerByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  customerId: string,
  rawInput: unknown,
  requestId: string
): Promise<CustomerRecord> {
  assertStaffPermission(actor, "customers.manage");
  const input = UpdateCustomerSchema.parse(rawInput);

  return store.withTransaction((state) => {
    const customer = state.customers.find((c) => c.id === customerId);
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
    const changes: Record<string, unknown> = {};

    if (input.name !== undefined) {
      customer.name = input.name.trim();
      changes.name = customer.name;
    }
    if (input.email !== undefined) {
      customer.email = input.email ? input.email.trim() : null;
      customer.normalized_email = input.email ? input.email.trim().toLowerCase() : null;
      changes.email = customer.email;
    }
    if (input.phone !== undefined) {
      customer.phone = input.phone ? input.phone.trim() : null;
      customer.normalized_phone = normalizePhoneE164(input.phone);
      changes.phone = customer.phone;
    }
    if (input.company_name !== undefined) {
      customer.company_name = input.company_name ? input.company_name.trim() : null;
      changes.company_name = customer.company_name;
    }
    if (input.country_code !== undefined) {
      customer.country_code = input.country_code.toUpperCase();
      changes.country_code = customer.country_code;
    }
    if (input.status !== undefined) {
      customer.status = input.status;
      changes.status = input.status;
    }
    if (input.notes !== undefined) {
      customer.notes = input.notes;
      changes.notes = customer.notes;
    }
    customer.updated_at = new Date().toISOString();

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "customers.customer.updated",
      resource_type: "customer",
      resource_id: customer.id,
      outcome: "success",
      request_id: requestId,
      changes,
    });
    return customer;
  });
}

import { randomUUID } from "node:crypto";
import {
  CreateCustomerAddressSchema,
  CreateCustomerReportSchema,
  CreateCustomerSchema,
  SplitCustomerContactSchema,
  UpdateCustomerAddressSchema,
  UpdateCustomerSchema,
} from "../../../../../packages/contracts/src/index.ts";
import type {
  CustomerAddressRecord,
  CustomerRecord,
  CustomerReportRecord,
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
    whatsapp?: string | null;
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
    whatsapp: input.whatsapp ? input.whatsapp.trim() : null,
    credit_balance_minor: 0,
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

// -- Dedupe (ADR-0009) ---------------------------------------------------------
// A normalized email / normalized phone each belong to AT MOST ONE customer.
// The primary lives on the customers row; secondaries live in
// customer_contacts. The unique partial indexes on both enforce it in the
// DB; this resolver enforces it in the app on every write path (admin
// create, inline order create, public checkout).

export type ContactMatch =
  | { kind: "none" }
  | { kind: "customer"; customer: CustomerRecord; matchedBy: "email" | "phone" }
  | {
      kind: "conflict";
      emailCustomer: CustomerRecord;
      phoneCustomer: CustomerRecord;
    };

export function findCustomerByContact(
  state: DatabaseState,
  email?: string | null,
  phone?: string | null
): ContactMatch {
  const normalizedEmail = email ? email.trim().toLowerCase() : null;
  const normalizedPhone = normalizePhoneE164(phone);

  const ownerOf = (kind: "email" | "phone", value: string | null): CustomerRecord | null => {
    if (!value) return null;
    const primary =
      kind === "email"
        ? state.customers.find((c) => c.normalized_email === value)
        : state.customers.find((c) => c.normalized_phone === value);
    if (primary) return primary;
    const contact = state.customer_contacts.find(
      (c) => c.kind === kind && c.normalized_value === value
    );
    return contact
      ? (state.customers.find((c) => c.id === contact.customer_id) ?? null)
      : null;
  };

  const emailOwner = ownerOf("email", normalizedEmail);
  const phoneOwner = ownerOf("phone", normalizedPhone);
  if (!emailOwner && !phoneOwner) return { kind: "none" };
  if (emailOwner && phoneOwner && emailOwner.id !== phoneOwner.id) {
    return { kind: "conflict", emailCustomer: emailOwner, phoneCustomer: phoneOwner };
  }
  const customer = emailOwner ?? phoneOwner;
  return {
    kind: "customer",
    customer: customer as CustomerRecord,
    matchedBy: emailOwner ? "email" : "phone",
  };
}

/** Attach a value as a secondary contact (no-op when already attached). */
export function attachSecondaryContactInTx(
  state: DatabaseState,
  customer: CustomerRecord,
  kind: "email" | "phone",
  value: string
): void {
  const normalized =
    kind === "email" ? value.trim().toLowerCase() : normalizePhoneE164(value);
  if (!normalized) return;
  const primaryValue =
    kind === "email" ? customer.normalized_email : customer.normalized_phone;
  if (primaryValue === normalized) return;
  if (
    state.customer_contacts.some(
      (c) =>
        c.customer_id === customer.id && c.kind === kind && c.normalized_value === normalized
    )
  ) {
    return;
  }
  state.customer_contacts.push({
    id: randomUUID(),
    customer_id: customer.id,
    kind,
    value: value.trim(),
    normalized_value: normalized,
    created_at: new Date().toISOString(),
  });
}

/**
 * Dedupe-aware resolve-or-create. Email match → that customer (a new phone
 * attaches as a secondary phone); phone match + new email → that customer
 * (email attaches as a secondary email); neither match → new customer; both
 * match different customers → 409 naming both (never auto-merge).
 */
export function resolveOrCreateCustomerInTx(
  state: DatabaseState,
  input: {
    customer_type?: "person" | "business";
    name: string;
    email?: string | null;
    phone?: string | null;
    whatsapp?: string | null;
    company_name?: string | null;
    country_code?: string;
    registration_source: string;
    notes?: string | null;
  }
): { customer: CustomerRecord; created: boolean } {
  const match = findCustomerByContact(state, input.email, input.phone);
  if (match.kind === "conflict") {
    throw new AppError(
      "CUSTOMER_CONTACT_CONFLICT",
      `This email belongs to ${match.emailCustomer.customer_number} and this phone belongs to ${match.phoneCustomer.customer_number}. Resolve the conflict before creating the customer — contacts are never auto-merged.`,
      409,
      {
        email_customer_id: match.emailCustomer.id,
        email_customer_number: match.emailCustomer.customer_number,
        phone_customer_id: match.phoneCustomer.id,
        phone_customer_number: match.phoneCustomer.customer_number,
      }
    );
  }
  if (match.kind === "customer") {
    const customer = match.customer;
    if (input.email) attachSecondaryContactInTx(state, customer, "email", input.email);
    if (input.phone) attachSecondaryContactInTx(state, customer, "phone", input.phone);
    if (input.whatsapp && !customer.whatsapp) {
      customer.whatsapp = input.whatsapp.trim();
    }
    customer.updated_at = new Date().toISOString();
    return { customer, created: false };
  }
  const customer = createCustomerInTx(state, input);
  return { customer, created: true };
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
    // Dedupe (ADR-0009): an email/phone match resolves to the existing
    // customer (new contact attaches as secondary); a conflict 409s.
    const { customer, created } = resolveOrCreateCustomerInTx(state, {
      customer_type: input.customer_type,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      whatsapp: input.whatsapp ?? null,
      company_name: input.company_name ?? null,
      country_code: input.country_code,
      registration_source: "admin",
      notes: input.notes ?? null,
    });

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: created ? "customers.customer.created" : "customers.customer.matched",
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
      const newEmail = input.email ? input.email.trim().toLowerCase() : null;
      if (newEmail && newEmail !== customer.normalized_email) {
        const owner = findCustomerByContact(state, input.email, null);
        if (owner.kind === "customer" && owner.customer.id !== customer.id) {
          throw new AppError(
            "CUSTOMER_CONTACT_CONFLICT",
            `This email belongs to ${owner.customer.customer_number}.`,
            409,
            { email_customer_id: owner.customer.id }
          );
        }
      }
      customer.email = input.email ? input.email.trim() : null;
      customer.normalized_email = newEmail;
      changes.email = customer.email;
    }
    if (input.phone !== undefined) {
      const newPhone = normalizePhoneE164(input.phone);
      if (newPhone && newPhone !== customer.normalized_phone) {
        const owner = findCustomerByContact(state, null, input.phone);
        if (owner.kind === "customer" && owner.customer.id !== customer.id) {
          throw new AppError(
            "CUSTOMER_CONTACT_CONFLICT",
            `This phone belongs to ${owner.customer.customer_number}.`,
            409,
            { phone_customer_id: owner.customer.id }
          );
        }
      }
      customer.phone = input.phone ? input.phone.trim() : null;
      customer.normalized_phone = newPhone;
      changes.phone = customer.phone;
    }
    if (input.whatsapp !== undefined) {
      customer.whatsapp = input.whatsapp ? input.whatsapp.trim() : null;
      changes.whatsapp = customer.whatsapp;
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

// -- Addresses (table exists since 0000; API wired in 0009) -------------------

export async function listCustomerAddresses(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  customerId: string
): Promise<CustomerAddressRecord[]> {
  assertStaffPermission(actor, "customers.read");
  const state = store.state;
  if (!state.customers.some((c) => c.id === customerId)) {
    throw new AppError("NOT_FOUND", "Customer not found.", 404);
  }
  return state.customer_addresses
    .filter((a) => a.customer_id === customerId)
    .sort((a, b) => (a.is_default === b.is_default ? 0 : a.is_default ? -1 : 1));
}

export async function createCustomerAddressByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  customerId: string,
  rawInput: unknown,
  requestId: string
): Promise<CustomerAddressRecord> {
  assertStaffPermission(actor, "customers.manage");
  const input = CreateCustomerAddressSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const customer = state.customers.find((c) => c.id === customerId);
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
    const now = new Date().toISOString();
    if (input.is_default) {
      for (const a of state.customer_addresses) {
        if (a.customer_id === customerId && a.is_default) a.is_default = false;
      }
    }
    const address: CustomerAddressRecord = {
      id: randomUUID(),
      customer_id: customerId,
      address_type: input.address_type,
      contact_name: input.contact_name ?? null,
      phone: input.phone ?? null,
      address_line_1: input.address_line_1 ?? null,
      address_line_2: input.address_line_2 ?? null,
      city: input.city ?? null,
      state_or_region: input.state_or_region ?? null,
      postal_code: input.postal_code ?? null,
      country_code: input.country_code.toUpperCase(),
      is_default: input.is_default,
      created_at: now,
      updated_at: now,
    };
    state.customer_addresses.push(address);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "customers.address.created",
      resource_type: "customer",
      resource_id: customerId,
      outcome: "success",
      request_id: requestId,
      changes: { address_id: address.id, address_type: address.address_type },
    });
    return address;
  });
}

export async function updateCustomerAddressByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  customerId: string,
  addressId: string,
  rawInput: unknown,
  requestId: string
): Promise<CustomerAddressRecord> {
  assertStaffPermission(actor, "customers.manage");
  const input = UpdateCustomerAddressSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const address = state.customer_addresses.find(
      (a) => a.id === addressId && a.customer_id === customerId
    );
    if (!address) throw new AppError("NOT_FOUND", "Address not found.", 404);
    const changes: Record<string, unknown> = {};
    if (input.address_type !== undefined) {
      address.address_type = input.address_type;
      changes.address_type = input.address_type;
    }
    if (input.contact_name !== undefined) {
      address.contact_name = input.contact_name ?? null;
      changes.contact_name = address.contact_name;
    }
    if (input.phone !== undefined) {
      address.phone = input.phone ?? null;
      changes.phone = address.phone;
    }
    if (input.address_line_1 !== undefined) {
      address.address_line_1 = input.address_line_1 ?? null;
      changes.address_line_1 = address.address_line_1;
    }
    if (input.address_line_2 !== undefined) {
      address.address_line_2 = input.address_line_2 ?? null;
      changes.address_line_2 = address.address_line_2;
    }
    if (input.city !== undefined) {
      address.city = input.city ?? null;
      changes.city = address.city;
    }
    if (input.state_or_region !== undefined) {
      address.state_or_region = input.state_or_region ?? null;
      changes.state_or_region = address.state_or_region;
    }
    if (input.postal_code !== undefined) {
      address.postal_code = input.postal_code ?? null;
      changes.postal_code = address.postal_code;
    }
    if (input.country_code !== undefined) {
      address.country_code = input.country_code.toUpperCase();
      changes.country_code = address.country_code;
    }
    if (input.is_default === true) {
      for (const a of state.customer_addresses) {
        if (a.customer_id === customerId && a.id !== addressId && a.is_default) {
          a.is_default = false;
        }
      }
      address.is_default = true;
      changes.is_default = true;
    }
    address.updated_at = new Date().toISOString();
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "customers.address.updated",
      resource_type: "customer",
      resource_id: customerId,
      outcome: "success",
      request_id: requestId,
      changes: { address_id: addressId, ...changes },
    });
    return address;
  });
}

export async function deleteCustomerAddressByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  customerId: string,
  addressId: string,
  requestId: string
): Promise<void> {
  assertStaffPermission(actor, "customers.manage");
  await store.withTransaction((state) => {
    const idx = state.customer_addresses.findIndex(
      (a) => a.id === addressId && a.customer_id === customerId
    );
    if (idx === -1) throw new AppError("NOT_FOUND", "Address not found.", 404);
    state.customer_addresses.splice(idx, 1);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "customers.address.deleted",
      resource_type: "customer",
      resource_id: customerId,
      outcome: "success",
      request_id: requestId,
      changes: { address_id: addressId },
    });
  });
}

// -- Staff reports on customers (ADR-0009) ------------------------------------

export async function listCustomerReports(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  customerId: string
): Promise<CustomerReportRecord[]> {
  assertStaffPermission(actor, "customers.read");
  const state = store.state;
  if (!state.customers.some((c) => c.id === customerId)) {
    throw new AppError("NOT_FOUND", "Customer not found.", 404);
  }
  return state.customer_reports
    .filter((r) => r.customer_id === customerId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function createCustomerReportByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  customerId: string,
  rawInput: unknown,
  requestId: string
): Promise<CustomerReportRecord> {
  assertStaffPermission(actor, "customers.manage");
  const input = CreateCustomerReportSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const customer = state.customers.find((c) => c.id === customerId);
    if (!customer) throw new AppError("NOT_FOUND", "Customer not found.", 404);
    const report: CustomerReportRecord = {
      id: randomUUID(),
      customer_id: customerId,
      author_user_id: actor.user.id,
      type: input.type,
      detail: input.detail.trim(),
      created_at: new Date().toISOString(),
    };
    state.customer_reports.push(report);
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "customers.report.created",
      resource_type: "customer",
      resource_id: customerId,
      outcome: "success",
      request_id: requestId,
      changes: { report_id: report.id, type: report.type },
    });
    return report;
  });
}

// -- Split a secondary contact into its own customer (ADR-0009) ---------------
// Orders stay with the source customer (documented default). The phone that
// moves with the email is the one the admin picks in the dialog; the default
// is the source customer's most recently added secondary phone (the pairing
// of "which phone arrived with which email" is not tracked — the brief's
// "latest order placed with that email" cannot be determined from the data,
// because orders carry no contact email; see ADR-0009). If the picked phone
// is the source's primary phone it MOVES (source primary cleared); if it is
// a secondary phone that contact row is removed. The source customer is
// mutated BEFORE the new customer is appended, so the store's upsert pass
// (array order) clears the old primary before inserting the new row — the
// unique index on normalized values never sees a duplicate.

export async function splitCustomerContactByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  customerId: string,
  rawInput: unknown,
  requestId: string
): Promise<CustomerRecord> {
  assertStaffPermission(actor, "customers.manage");
  const input = SplitCustomerContactSchema.parse(rawInput);
  return store.withTransaction((state) => {
    const source = state.customers.find((c) => c.id === customerId);
    if (!source) throw new AppError("NOT_FOUND", "Customer not found.", 404);
    const kind = input.contact_kind;
    const normalized =
      kind === "email" ? input.value.trim().toLowerCase() : normalizePhoneE164(input.value);
    if (!normalized) throw new AppError("VALIDATION_ERROR", "Contact value is empty.", 422);

    const primaryValue = kind === "email" ? source.normalized_email : source.normalized_phone;
    if (primaryValue === normalized) {
      throw new AppError(
        "VALIDATION_ERROR",
        "That is the customer's primary contact. Change the primary first, then split a secondary contact.",
        422
      );
    }
    const contactIdx = state.customer_contacts.findIndex(
      (c) => c.customer_id === customerId && c.kind === kind && c.normalized_value === normalized
    );
    if (contactIdx === -1) {
      throw new AppError(
        "NOT_FOUND",
        "That contact is not a secondary contact of this customer.",
        404
      );
    }

    // Resolve the phone that moves with the contact.
    let movePhone: string | null = null;
    let movePhoneNormalized: string | null = null;
    if (kind === "email") {
      if (input.phone) {
        movePhone = input.phone.trim();
        movePhoneNormalized = normalizePhoneE164(input.phone);
      } else {
        const secondaryPhones = state.customer_contacts
          .filter((c) => c.customer_id === customerId && c.kind === "phone")
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        const latest = secondaryPhones[0];
        movePhone = latest ? latest.value : source.phone;
        movePhoneNormalized = latest ? latest.normalized_value : source.normalized_phone;
      }
      if (movePhoneNormalized) {
        const owner = findCustomerByContact(state, null, movePhone);
        if (owner.kind === "customer" && owner.customer.id !== source.id) {
          throw new AppError(
            "CUSTOMER_CONTACT_CONFLICT",
            `That phone belongs to ${owner.customer.customer_number}.`,
            409,
            { phone_customer_id: owner.customer.id }
          );
        }
      }
    }

    // Detach + move, BEFORE creating the new customer (ordering note above).
    state.customer_contacts.splice(contactIdx, 1);
    if (kind === "email" && movePhoneNormalized) {
      if (source.normalized_phone === movePhoneNormalized) {
        source.phone = null;
        source.normalized_phone = null;
      } else {
        const phoneIdx = state.customer_contacts.findIndex(
          (c) =>
            c.customer_id === customerId && c.kind === "phone" && c.normalized_value === movePhoneNormalized
        );
        if (phoneIdx !== -1) state.customer_contacts.splice(phoneIdx, 1);
      }
    }
    source.updated_at = new Date().toISOString();

    const newCustomer = createCustomerInTx(state, {
      customer_type: source.customer_type,
      name: input.new_customer_name?.trim() || source.name,
      email: kind === "email" ? input.value.trim() : null,
      phone: kind === "phone" ? input.value.trim() : movePhone,
      registration_source: "split",
      notes: `Split from ${source.customer_number} (${kind}: ${input.value.trim()}). Orders stay with ${source.customer_number}.`,
    });

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "customers.customer.split",
      resource_type: "customer",
      resource_id: source.id,
      outcome: "success",
      request_id: requestId,
      changes: {
        detached_kind: kind,
        detached_value: input.value.trim(),
        new_customer_id: newCustomer.id,
        new_customer_number: newCustomer.customer_number,
      },
    });
    return newCustomer;
  });
}

// -- Financial overview (ADR-0009) --------------------------------------------
// Order paid = sum of installment paid_amount_minor when the order has
// installments (includes credit applied at approval); legacy orders without
// installments fall back to the sum of succeeded payment transactions.
// Customer "total paid" = money only (succeeded transactions); credit is its
// own line, so billed − paid(money) ≠ due when credit was applied.

export function computeOrderPaidMoney(state: DatabaseState, orderId: string): number {
  return state.payment_transactions
    .filter((t) => t.order_id === orderId && t.status === "succeeded")
    .reduce((sum, t) => sum + t.amount_minor, 0);
}

export function computeOrderPaid(state: DatabaseState, orderId: string): number {
  const installments = state.order_installments.filter((i) => i.order_id === orderId);
  if (installments.length > 0) {
    return installments.reduce((sum, i) => sum + i.paid_amount_minor, 0);
  }
  return computeOrderPaidMoney(state, orderId);
}

export function computeOrderRemaining(
  state: DatabaseState,
  order: { id: string; total_minor: number }
): number {
  return Math.max(0, order.total_minor - computeOrderPaid(state, order.id));
}

export interface CustomerFinancials {
  total_billed_minor: number;
  total_paid_minor: number;
  total_due_minor: number;
  credit_balance_minor: number;
}

export function computeCustomerFinancials(
  state: DatabaseState,
  customerId: string
): CustomerFinancials {
  const customer = state.customers.find((c) => c.id === customerId);
  const orders = state.orders.filter(
    (o) => o.customer_id === customerId && o.status !== "cancelled"
  );
  const total_billed_minor = orders.reduce((sum, o) => sum + o.total_minor, 0);
  const total_paid_minor = orders.reduce(
    (sum, o) => sum + computeOrderPaidMoney(state, o.id),
    0
  );
  const total_due_minor = orders.reduce(
    (sum, o) => sum + computeOrderRemaining(state, o),
    0
  );
  return {
    total_billed_minor,
    total_paid_minor,
    total_due_minor,
    credit_balance_minor: customer?.credit_balance_minor ?? 0,
  };
}

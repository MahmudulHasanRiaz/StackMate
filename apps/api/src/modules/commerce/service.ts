import { randomUUID } from "node:crypto";
import {
  AdminCreateOrderSchema,
  calculateLineTotals,
  calculateOrderTotals,
  computeCanonicalSnapshotHash,
  PublicCreateCheckoutOrderSchema,
  validateFeatureEntitlementValue,
} from "../../../../../packages/contracts/src/index.ts";
import {
  issueCheckoutAccessToken,
  randomOpaqueToken,
} from "../../platform/crypto/index.ts";
import type {
  CustomerRecord,
  DatabaseState,
  InvoiceRecord,
  LeadRecord,
  OrderItemRecord,
  OrderRecord,
  PaymentMethodRecord,
  StackMateDataStore,
} from "../../platform/db/store.ts";
import { AppError } from "../../shared/errors.ts";
import { appendAuditLog } from "../audit/service.ts";
import { resolveOrCreateCustomerInTx } from "../customers/service.ts";
import { createInstallmentsForOrderInTx } from "../payments/service.ts";
import { assertStaffPermission, type StaffPrincipal } from "../identity/service.ts";

export function generateInvoiceForOrderInTx(
  state: DatabaseState,
  order: OrderRecord,
  invoiceType: "initial" | "renewal" = "initial",
  subscriptionId: string | null = null
): InvoiceRecord {
  state.sequence_counters.invoice += 1;
  const invoiceNumber = `INV-${state.sequence_counters.invoice}`;
  const now = new Date().toISOString();

  const invoice: InvoiceRecord = {
    id: randomUUID(),
    invoice_number: invoiceNumber,
    customer_id: order.customer_id,
    order_id: order.id,
    subscription_id: subscriptionId,
    invoice_type: invoiceType,
    status: order.payment_status === "paid" ? "paid" : "open",
    currency_code: order.currency_code,
    subtotal_minor: order.subtotal_minor,
    discount_minor: order.discount_minor,
    tax_minor: order.tax_minor,
    total_minor: order.total_minor,
    amount_paid_minor: order.payment_status === "paid" ? order.total_minor : 0,
    amount_due_minor: order.payment_status === "paid" ? 0 : order.total_minor,
    issued_at: now,
    paid_at: order.payment_status === "paid" ? now : null,
    items: order.items.map((item) => ({
      id: randomUUID(),
      description_snapshot: item.package_name_snapshot
        ? `${item.product_name_snapshot} — ${item.package_name_snapshot} (v${item.package_version_snapshot ?? 1})`
        : item.product_name_snapshot,
      quantity: item.quantity,
      unit_amount_minor: item.unit_amount_minor,
      line_amount_minor: item.line_total_minor,
      currency_code: item.currency_code,
    })),
    created_at: now,
  };
  state.invoices.push(invoice);
  return invoice;
}

/**
 * Creates a server-authoritative order from an external website checkout (API Spec §14.3).
 * Rejects any client-supplied prices, discounts, totals, or entitlement claims.
 */
export async function createPublicCheckoutOrder(
  store: StackMateDataStore,
  input: {
    siteKey: string;
    idempotencyKey: string;
    checkoutTokenSecret: string;
    rawBody: unknown;
    requestId: string;
  }
): Promise<{
  replayed: boolean;
  order: {
    id: string;
    order_number: string;
    public_reference: string;
    status: string;
    payment_status: string;
    currency_code: string;
    subtotal_minor: number;
    discount_minor: number;
    tax_minor: number;
    total_minor: number;
    items: Array<{
      product_name: string;
      package_name: string | null;
      quantity: number;
      unit_amount_minor: number;
      line_total_minor: number;
    }>;
  };
  checkout_access_token: string;
  checkout_token_expires_at: string;
}> {
  const parsed = PublicCreateCheckoutOrderSchema.parse(input.rawBody);

  const res = await store.executeIdempotent(
    `public_checkout:${input.siteKey}`,
    input.idempotencyKey,
    parsed,
    201,
    (state) => {
      const site = state.integrated_sites.find((s) => s.site_key === input.siteKey);
      if (!site || site.status !== "active") {
        throw new AppError("UNAUTHORIZED", "Integrated site is not active.", 401);
      }
      if (!site.allowed_capabilities.includes("checkout.create")) {
        throw new AppError("FORBIDDEN", "Site does not have checkout.create capability.", 403);
      }

      // Dedupe (ADR-0009): the same email/phone never creates a second
      // customer — a match resolves to the existing customer (the new phone
      // or email attaches as a secondary contact); a conflict 409s.
      const { customer } = resolveOrCreateCustomerInTx(state, {
        customer_type: parsed.customer.company_name ? "business" : "person",
        name: parsed.customer.name,
        email: parsed.customer.email ?? null,
        phone: parsed.customer.phone ?? null,
        company_name: parsed.customer.company_name ?? null,
        country_code: parsed.billing_address?.country_code ?? "BD",
        registration_source: "website",
      });

      // Store the checkout billing address (table exists since 0000).
      if (parsed.billing_address?.address_line_1 || parsed.billing_address?.city) {
        const hasAddress = state.customer_addresses.some(
          (a) => a.customer_id === customer.id && a.address_type === "billing"
        );
        if (!hasAddress) {
          state.customer_addresses.push({
            id: randomUUID(),
            customer_id: customer.id,
            address_type: "billing",
            contact_name: parsed.customer.name,
            phone: parsed.customer.phone ?? null,
            address_line_1: parsed.billing_address.address_line_1 ?? null,
            address_line_2: null,
            city: parsed.billing_address.city ?? null,
            state_or_region: null,
            postal_code: parsed.billing_address.postal_code ?? null,
            country_code: parsed.billing_address.country_code ?? "BD",
            is_default: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }

      const orderId = randomUUID();
      const orderItems: OrderItemRecord[] = [];
      const lineSummaries = [];
      const now = new Date().toISOString();

      for (const itemReq of parsed.items) {
        const product = state.products.find(
          (p) => p.slug === itemReq.product_slug && p.status === "active"
        );
        if (!product) {
          throw new AppError(
            "NOT_FOUND",
            `Active product '${itemReq.product_slug}' not found.`,
            404
          );
        }
        if (!site.product_ids.includes(product.id)) {
          throw new AppError(
            "SITE_NOT_AUTHORIZED_FOR_PRODUCT",
            `Site '${site.name}' is not authorized to sell product '${product.code}'.`,
            403
          );
        }

        const pkgVersion = state.package_versions.find(
          (v) =>
            v.id === itemReq.package_version_id &&
            v.product_id === product.id &&
            v.status === "published"
        );
        if (!pkgVersion) {
          throw new AppError(
            "NOT_FOUND",
            "Published package version not found for the selected product.",
            404
          );
        }

        const pkg = state.product_packages.find(
          (p) => p.id === pkgVersion.package_id && p.status === "active"
        );
        if (!pkg) {
          throw new AppError("NOT_FOUND", "Active package not found.", 404);
        }

        const price = state.package_prices.find(
          (pr) =>
            pr.id === itemReq.price_id &&
            pr.package_version_id === pkgVersion.id &&
            pr.status === "active"
        );
        if (!price) {
          throw new AppError("NOT_FOUND", "Active price option not found for package version.", 404);
        }

        price.used_in_orders = true;
        const unitAmount = price.amount_minor + price.setup_fee_minor;
        const linePricing = calculateLineTotals({
          unit_amount_minor: unitAmount,
          quantity: itemReq.quantity,
          currency_code: price.currency_code,
        });
        lineSummaries.push(linePricing);

        const orderItemId = randomUUID();
        const snapshotItems = pkgVersion.features.map((f) => ({
          feature_key_snapshot: f.feature_key_snapshot,
          value_type_snapshot: f.value_type_snapshot,
          entitlement_value: structuredClone(f.entitlement_value),
          unit_snapshot: f.unit_snapshot,
        }));
        const snapshotHash = computeCanonicalSnapshotHash(
          snapshotItems.map((si) => ({
            feature_key: si.feature_key_snapshot,
            value_type: si.value_type_snapshot,
            entitlement_value: si.entitlement_value,
            unit: si.unit_snapshot,
          }))
        );

        let activationLimit = product.default_activation_limit;
        for (const si of snapshotItems) {
          if (
            (si.feature_key_snapshot === "max_websites" ||
              si.feature_key_snapshot === "max_sites" ||
              si.feature_key_snapshot === "max_activations") &&
            typeof si.entitlement_value === "object" &&
            si.entitlement_value !== null
          ) {
            const valObj = si.entitlement_value as { value?: number | null; unlimited?: boolean };
            if (valObj.unlimited) {
              activationLimit = 10000;
            } else if (typeof valObj.value === "number" && valObj.value >= 1) {
              activationLimit = valObj.value;
            }
          }
        }

        orderItems.push({
          id: orderItemId,
          order_id: orderId,
          product_id: product.id,
          package_id: pkg.id,
          package_version_id: pkgVersion.id,
          package_price_id: price.id,
          item_kind: "package",
          fulfillment_type_snapshot: product.fulfillment_type,
          product_name_snapshot: product.name,
          package_name_snapshot: pkg.name,
          package_version_snapshot: pkgVersion.version_number,
          price_kind_snapshot: price.price_kind,
          interval_unit_snapshot: price.interval_unit,
          interval_count_snapshot: price.interval_count,
          activation_limit_snapshot: activationLimit,
          quantity: itemReq.quantity,
          unit_amount_minor: linePricing.unit_amount_minor,
          line_subtotal_minor: linePricing.line_subtotal_minor,
          line_discount_minor: linePricing.line_discount_minor,
          line_tax_minor: linePricing.line_tax_minor,
          line_total_minor: linePricing.line_total_minor,
          currency_code: linePricing.currency_code,
          entitlement_snapshot: {
            id: randomUUID(),
            order_item_id: orderItemId,
            source_type: "package_version",
            source_package_version_id: pkgVersion.id,
            schema_version: 1,
            snapshot_hash: snapshotHash,
            items: snapshotItems,
            created_at: now,
          },
          created_at: now,
        });
      }

      const totals = calculateOrderTotals(lineSummaries, 0, 0);
      state.sequence_counters.order += 1;
      const orderNumber = `ORD-${state.sequence_counters.order}`;
      const publicReference = randomOpaqueToken("SMO", 18);

      const order: OrderRecord = {
        id: orderId,
        order_number: orderNumber,
        public_reference: publicReference,
        customer_id: customer.id,
        source: "website",
        integrated_site_id: site.id,
        status: "awaiting_payment",
        payment_status: "unpaid",
        currency_code: totals.currency_code,
        subtotal_minor: totals.subtotal_minor,
        discount_minor: totals.discount_minor,
        tax_minor: totals.tax_minor,
        total_minor: totals.total_minor,
        customer_note: parsed.customer_note ?? null,
        internal_note: null,
        items: orderItems,
        attribution: parsed.attribution ?? null,
        created_by_user_id: null,
        activation_mode: "on_full_payment",
        activation_percent: null,
        activation_date: null,
        suspend_on_missed_schedule: false,
        grace_days: 3,
        payment_method_id: null,
        lead_id: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
        cancelled_at: null,
      };
      state.orders.push(order);
      generateInvoiceForOrderInTx(state, order, "initial");

      state.outbox_events.push({
        id: randomUUID(),
        event_key: `order.created:${order.id}`,
        aggregate_type: "order",
        aggregate_id: order.id,
        event_type: "order.created",
        payload: {
          order_reference: order.public_reference,
          order_number: order.order_number,
          currency_code: order.currency_code,
          total_minor: order.total_minor,
        },
        status: "pending",
        attempt_count: 0,
        available_at: now,
        locked_until: null,
        locked_by: null,
        last_error_code: null,
        created_at: now,
        processed_at: null,
      });

      const expUnix = Math.floor(Date.now() / 1000) + 2 * 3600;
      const checkoutAccessToken = issueCheckoutAccessToken(
        {
          oid: order.id,
          ref: order.public_reference,
          sid: site.id,
          exp: expUnix,
        },
        input.checkoutTokenSecret
      );

      return {
        order: {
          id: order.id,
          order_number: order.order_number,
          public_reference: order.public_reference,
          status: order.status,
          payment_status: order.payment_status,
          currency_code: order.currency_code,
          subtotal_minor: order.subtotal_minor,
          discount_minor: order.discount_minor,
          tax_minor: order.tax_minor,
          total_minor: order.total_minor,
          items: order.items.map((it) => ({
            product_name: it.product_name_snapshot,
            package_name: it.package_name_snapshot,
            quantity: it.quantity,
            unit_amount_minor: it.unit_amount_minor,
            line_total_minor: it.line_total_minor,
          })),
        },
        checkout_access_token: checkoutAccessToken,
        checkout_token_expires_at: new Date(expUnix * 1000).toISOString(),
      };
    }
  );

  return {
    replayed: res.replayed,
    ...res.body,
  };
}

/**
 * Admin Order Creation supporting both Reusable Published Packages and Custom Package Deals (PRD §8 & §10.4).
 * Never marks an order as paid automatically.
 */
export async function createOrderByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  rawInput: unknown,
  requestId: string
): Promise<{ order: OrderRecord; invoice: InvoiceRecord }> {
  assertStaffPermission(actor, "orders.create");
  const input = AdminCreateOrderSchema.parse(rawInput);

  return store.withTransaction((state) => {
    // Customer: exactly one of customer_id / new_customer (schema refine).
    // new_customer is validated + deduped exactly like POST /customers.
    let customer: CustomerRecord;
    if (input.new_customer) {
      const nc = input.new_customer;
      customer = resolveOrCreateCustomerInTx(state, {
        customer_type: nc.customer_type,
        name: nc.name,
        email: nc.email ?? null,
        phone: nc.phone ?? null,
        whatsapp: nc.whatsapp ?? null,
        company_name: nc.company_name ?? null,
        country_code: nc.country_code,
        registration_source: "admin",
        notes: nc.notes ?? null,
      }).customer;
    } else {
      const found = state.customers.find((c) => c.id === input.customer_id);
      if (!found) throw new AppError("NOT_FOUND", "Customer not found.", 404);
      customer = found;
    }
    const product = state.products.find((p) => p.id === input.product_id);
    if (!product) throw new AppError("NOT_FOUND", "Product not found.", 404);

    // Lead conversion (ADR-0009): the order links the lead; the lead is
    // marked converted (history stays) once the order exists.
    let lead: LeadRecord | null = null;
    if (input.lead_id) {
      lead = state.leads.find((l) => l.id === input.lead_id) ?? null;
      if (!lead) throw new AppError("NOT_FOUND", "Lead not found.", 404);
      if (lead.status === "converted") {
        throw new AppError(
          "LEAD_ALREADY_CONVERTED",
          `Lead ${lead.lead_number} is already converted.`,
          409
        );
      }
    }

    // Payment method the order will be paid with (stored on the order).
    let paymentMethod: PaymentMethodRecord | null = null;
    if (input.payment_method_id) {
      paymentMethod =
        state.payment_methods.find((m) => m.id === input.payment_method_id) ?? null;
      if (!paymentMethod) throw new AppError("NOT_FOUND", "Payment method not found.", 404);
    }

    const now = new Date().toISOString();
    const orderId = randomUUID();
    const orderItemId = randomUUID();
    let orderItem: OrderItemRecord;

    if (input.item_kind === "custom") {
      if (!input.custom_offer) {
        throw new AppError(
          "VALIDATION_ERROR",
          "custom_offer configuration is required when item_kind is 'custom'.",
          422
        );
      }
      const offer = input.custom_offer;
      const snapshotItems = offer.features.map((f) => {
        const featureDef = state.product_features.find((fd) => fd.id === f.product_feature_id);
        if (!featureDef) {
          throw new AppError("NOT_FOUND", `Feature '${f.product_feature_id}' not found.`, 404);
        }
        if (featureDef.product_id !== product.id) {
          throw new AppError(
            "CROSS_PRODUCT_FEATURE_ERROR",
            `Feature '${featureDef.feature_key}' does not belong to product '${product.code}'.`,
            422
          );
        }
        const validatedVal = validateFeatureEntitlementValue(
          featureDef.value_type,
          f.entitlement_value
        );
        return {
          feature_key_snapshot: featureDef.feature_key,
          value_type_snapshot: featureDef.value_type,
          entitlement_value: validatedVal,
          unit_snapshot: featureDef.unit,
        };
      });

      const snapshotHash = computeCanonicalSnapshotHash(
        snapshotItems.map((si) => ({
          feature_key: si.feature_key_snapshot,
          value_type: si.value_type_snapshot,
          entitlement_value: si.entitlement_value,
          unit: si.unit_snapshot,
        }))
      );

      const linePricing = calculateLineTotals({
        unit_amount_minor: offer.unit_amount_minor,
        quantity: input.quantity,
        line_discount_minor: input.discount_minor,
        line_tax_minor: input.tax_minor,
        currency_code: offer.currency_code,
      });

      orderItem = {
        id: orderItemId,
        order_id: orderId,
        product_id: product.id,
        package_id: null,
        package_version_id: null,
        package_price_id: null,
        item_kind: "custom",
        fulfillment_type_snapshot: product.fulfillment_type,
        product_name_snapshot: product.name,
        package_name_snapshot: offer.label,
        package_version_snapshot: null,
        price_kind_snapshot: offer.price_kind,
        interval_unit_snapshot: offer.interval_unit ?? null,
        interval_count_snapshot: offer.interval_count ?? null,
        activation_limit_snapshot: offer.activation_limit,
        quantity: input.quantity,
        unit_amount_minor: linePricing.unit_amount_minor,
        line_subtotal_minor: linePricing.line_subtotal_minor,
        line_discount_minor: linePricing.line_discount_minor,
        line_tax_minor: linePricing.line_tax_minor,
        line_total_minor: linePricing.line_total_minor,
        currency_code: linePricing.currency_code,
        entitlement_snapshot: {
          id: randomUUID(),
          order_item_id: orderItemId,
          source_type: "custom_offer",
          source_package_version_id: null,
          schema_version: 1,
          snapshot_hash: snapshotHash,
          items: snapshotItems,
          created_at: now,
        },
        created_at: now,
      };
    } else {
      if (!input.package_version_id || !input.package_price_id) {
        throw new AppError(
          "VALIDATION_ERROR",
          "package_version_id and package_price_id are required for package orders.",
          422
        );
      }
      const pkgVersion = state.package_versions.find(
        (v) => v.id === input.package_version_id && v.product_id === product.id
      );
      if (!pkgVersion || pkgVersion.status !== "published") {
        throw new AppError("VALIDATION_ERROR", "Selected package version must be published.", 422);
      }
      const pkg = state.product_packages.find((p) => p.id === pkgVersion.package_id);
      if (!pkg) throw new AppError("NOT_FOUND", "Package not found.", 404);
      const price = state.package_prices.find(
        (pr) => pr.id === input.package_price_id && pr.package_version_id === pkgVersion.id
      );
      if (!price || price.status !== "active") {
        throw new AppError("VALIDATION_ERROR", "Selected package price is not active.", 422);
      }
      price.used_in_orders = true;

      const linePricing = calculateLineTotals({
        unit_amount_minor: price.amount_minor + price.setup_fee_minor,
        quantity: input.quantity,
        line_discount_minor: input.discount_minor,
        line_tax_minor: input.tax_minor,
        currency_code: price.currency_code,
      });

      const snapshotItems = pkgVersion.features.map((f) => ({
        feature_key_snapshot: f.feature_key_snapshot,
        value_type_snapshot: f.value_type_snapshot,
        entitlement_value: structuredClone(f.entitlement_value),
        unit_snapshot: f.unit_snapshot,
      }));
      const snapshotHash = computeCanonicalSnapshotHash(
        snapshotItems.map((si) => ({
          feature_key: si.feature_key_snapshot,
          value_type: si.value_type_snapshot,
          entitlement_value: si.entitlement_value,
          unit: si.unit_snapshot,
        }))
      );

      orderItem = {
        id: orderItemId,
        order_id: orderId,
        product_id: product.id,
        package_id: pkg.id,
        package_version_id: pkgVersion.id,
        package_price_id: price.id,
        item_kind: "package",
        fulfillment_type_snapshot: product.fulfillment_type,
        product_name_snapshot: product.name,
        package_name_snapshot: pkg.name,
        package_version_snapshot: pkgVersion.version_number,
        price_kind_snapshot: price.price_kind,
        interval_unit_snapshot: price.interval_unit,
        interval_count_snapshot: price.interval_count,
        activation_limit_snapshot: product.default_activation_limit,
        quantity: input.quantity,
        unit_amount_minor: linePricing.unit_amount_minor,
        line_subtotal_minor: linePricing.line_subtotal_minor,
        line_discount_minor: linePricing.line_discount_minor,
        line_tax_minor: linePricing.line_tax_minor,
        line_total_minor: linePricing.line_total_minor,
        currency_code: linePricing.currency_code,
        entitlement_snapshot: {
          id: randomUUID(),
          order_item_id: orderItemId,
          source_type: "package_version",
          source_package_version_id: pkgVersion.id,
          schema_version: 1,
          snapshot_hash: snapshotHash,
          items: snapshotItems,
          created_at: now,
        },
        created_at: now,
      };
    }

    const totals = calculateOrderTotals(
      [
        {
          currency_code: orderItem.currency_code,
          unit_amount_minor: orderItem.unit_amount_minor,
          quantity: orderItem.quantity,
          line_subtotal_minor: orderItem.line_subtotal_minor,
          line_discount_minor: orderItem.line_discount_minor,
          line_tax_minor: orderItem.line_tax_minor,
          line_total_minor: orderItem.line_total_minor,
        },
      ],
      0,
      0
    );

    state.sequence_counters.order += 1;
    const orderNumber = `ORD-${state.sequence_counters.order}`;
    const publicReference = randomOpaqueToken("SMO", 18);

    const order: OrderRecord = {
      id: orderId,
      order_number: orderNumber,
      public_reference: publicReference,
      customer_id: customer.id,
      source: "admin",
      integrated_site_id: null,
      status: "awaiting_payment",
      payment_status: "unpaid",
      currency_code: totals.currency_code,
      subtotal_minor: totals.subtotal_minor,
      discount_minor: totals.discount_minor,
      tax_minor: totals.tax_minor,
      total_minor: totals.total_minor,
      customer_note: input.customer_note ?? null,
      internal_note: input.internal_note ?? null,
      items: [orderItem],
      attribution: null,
      created_by_user_id: actor.user.id,
      activation_mode: input.activation_mode,
      activation_percent:
        input.activation_mode === "on_percent" ? (input.activation_percent ?? 100) : null,
      activation_date:
        input.activation_mode === "on_date" ? (input.activation_date ?? null) : null,
      suspend_on_missed_schedule: input.suspend_on_missed_schedule,
      grace_days: input.grace_days,
      payment_method_id: paymentMethod?.id ?? null,
      lead_id: lead?.id ?? null,
      created_at: now,
      updated_at: now,
      completed_at: null,
      cancelled_at: null,
    };

    state.orders.push(order);
    // Payment plan (ADR-0009): installments always exist — one-time full
    // is a single installment — so paid/remaining is always computable.
    createInstallmentsForOrderInTx(state, order, input.payment_plan, new Date(now));
    const invoice = generateInvoiceForOrderInTx(state, order, "initial");

    if (lead) {
      lead.status = "converted";
      lead.converted_at = now;
      lead.converted_customer_id = customer.id;
      lead.converted_order_id = order.id;
      lead.updated_at = now;
    }

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "commerce.order.created",
      resource_type: "order",
      resource_id: order.id,
      outcome: "success",
      request_id: requestId,
      changes: {
        order_number: order.order_number,
        item_kind: orderItem.item_kind,
        total_minor: order.total_minor,
        currency_code: order.currency_code,
        activation_mode: order.activation_mode,
        payment_plan_kind: input.payment_plan?.kind ?? "full",
        lead_id: lead?.id ?? null,
      },
    });

    return { order, invoice };
  });
}

/**
 * Shared order-cancellation core (API Spec §10.2, §21.2). Used by the
 * staff admin endpoint and by the server-to-server cancel endpoint
 * (§15, scope orders.cancel:own) — the caller has already proven its own
 * authorization; this function enforces the state machine only.
 */
export function cancelOrderInTx(
  state: DatabaseState,
  order: OrderRecord,
  opts: {
    actorType: "staff" | "integration";
    actorUserId?: string | null;
    integratedSiteId?: string | null;
    reason: string;
    requestId: string;
  }
): OrderRecord {
  if (order.status === "cancelled") {
    throw new AppError("CONFLICT", "Order is already cancelled.", 409);
  }
  if (order.status === "completed") {
    throw new AppError("CONFLICT", "Completed orders cannot be cancelled.", 409);
  }
  if (order.status === "failed") {
    throw new AppError("CONFLICT", "Failed orders cannot be cancelled.", 409);
  }
  if (order.payment_status === "paid") {
    throw new AppError(
      "CONFLICT",
      "Paid orders cannot be cancelled. Issue a refund through the financial workflow instead.",
      409
    );
  }
  const pendingReview = state.payment_submissions.some(
    (s) =>
      s.order_id === order.id && (s.status === "submitted" || s.status === "under_review")
  );
  if (pendingReview) {
    throw new AppError(
      "CONFLICT",
      "A payment submission for this order is still under verification. Approve or reject it first.",
      409
    );
  }

  const nowIso = new Date().toISOString();
  const prevStatus = order.status;
  order.status = "cancelled";
  order.cancelled_at = nowIso;
  order.updated_at = nowIso;

  state.outbox_events.push({
    id: randomUUID(),
    event_key: `order.cancelled:${order.id}`,
    aggregate_type: "order",
    aggregate_id: order.id,
    event_type: "order.cancelled",
    payload: {
      order_reference: order.public_reference,
      order_number: order.order_number,
      status: "cancelled",
    },
    status: "pending",
    attempt_count: 0,
    available_at: nowIso,
    locked_until: null,
    locked_by: null,
    last_error_code: null,
    created_at: nowIso,
    processed_at: null,
  });

  appendAuditLog(state, {
    actor_type: opts.actorType,
    actor_user_id: opts.actorUserId ?? null,
    integrated_site_id: opts.integratedSiteId ?? null,
    action: "commerce.order.cancelled",
    resource_type: "order",
    resource_id: order.id,
    outcome: "success",
    request_id: opts.requestId,
    changes: { from_status: prevStatus, to_status: "cancelled", reason: opts.reason },
  });
  return order;
}

export async function cancelOrderByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  orderId: string,
  rawInput: unknown,
  requestId: string
): Promise<OrderRecord> {
  assertStaffPermission(actor, "orders.manage");
  const reason =
    typeof (rawInput as { reason?: unknown } | null)?.reason === "string" &&
    ((rawInput as { reason: string }).reason.trim().length ?? 0) > 0
      ? (rawInput as { reason: string }).reason.trim()
      : "Cancelled by staff";
  return store.withTransaction((state) => {
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
    return cancelOrderInTx(state, order, {
      actorType: "staff",
      actorUserId: actor.user.id,
      reason,
      requestId,
    });
  });
}

export async function completeOrderByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  orderId: string,
  requestId: string
): Promise<OrderRecord> {
  assertStaffPermission(actor, "orders.manage");
  return store.withTransaction((state) => {
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
    if (order.status === "completed") {
      throw new AppError("CONFLICT", "Order is already completed.", 409);
    }
    if (order.status === "cancelled" || order.status === "failed") {
      throw new AppError(
        "CONFLICT",
        `A ${order.status} order cannot be completed.`,
        409
      );
    }
    // API Spec §10.2: completion must never bypass payment verification.
    if (order.payment_status !== "paid") {
      throw new AppError(
        "CONFLICT",
        `Order cannot be completed while payment_status is '${order.payment_status}'. Verify the payment first.`,
        409
      );
    }
    const prevStatus = order.status;
    const nowIso = new Date().toISOString();
    order.status = "completed";
    order.completed_at = nowIso;
    order.updated_at = nowIso;

    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "commerce.order.completed",
      resource_type: "order",
      resource_id: order.id,
      outcome: "success",
      request_id: requestId,
      changes: { from_status: prevStatus, to_status: "completed" },
    });
    return order;
  });
}

export async function createInvoiceForOrderByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  orderId: string,
  requestId: string
): Promise<InvoiceRecord> {
  assertStaffPermission(actor, "orders.manage");
  return store.withTransaction((state) => {
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new AppError("NOT_FOUND", "Order not found.", 404);
    const existingInitial = state.invoices.find(
      (i) => i.order_id === order.id && i.invoice_type === "initial" && i.status !== "void"
    );
    if (existingInitial) {
      throw new AppError(
        "CONFLICT",
        `Order already has a live initial invoice '${existingInitial.invoice_number}'.`,
        409
      );
    }
    const invoice = generateInvoiceForOrderInTx(state, order, "initial");
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "commerce.invoice.created",
      resource_type: "invoice",
      resource_id: invoice.id,
      outcome: "success",
      request_id: requestId,
      changes: { order_id: order.id, invoice_number: invoice.invoice_number },
    });
    return invoice;
  });
}

export async function voidInvoiceByAdmin(
  store: StackMateDataStore,
  actor: StaffPrincipal,
  invoiceId: string,
  rawInput: unknown,
  requestId: string
): Promise<InvoiceRecord> {
  assertStaffPermission(actor, "orders.manage");
  const reason =
    typeof (rawInput as { reason?: unknown } | null)?.reason === "string" &&
    ((rawInput as { reason: string }).reason.trim().length ?? 0) > 0
      ? (rawInput as { reason: string }).reason.trim()
      : "Voided by staff";
  return store.withTransaction((state) => {
    const invoice = state.invoices.find((i) => i.id === invoiceId);
    if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found.", 404);
    if (invoice.status === "void") {
      throw new AppError("CONFLICT", "Invoice is already void.", 409);
    }
    if (invoice.status === "paid") {
      throw new AppError(
        "CONFLICT",
        "A paid invoice cannot be voided. Issue a credit note through the financial workflow instead.",
        409
      );
    }
    const prevStatus = invoice.status;
    invoice.status = "void";
    appendAuditLog(state, {
      actor_type: "staff",
      actor_user_id: actor.user.id,
      action: "commerce.invoice.voided",
      resource_type: "invoice",
      resource_id: invoice.id,
      outcome: "success",
      request_id: requestId,
      changes: { from_status: prevStatus, to_status: "void", reason },
    });
    return invoice;
  });
}

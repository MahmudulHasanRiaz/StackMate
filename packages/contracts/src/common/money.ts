/**
 * Currency-aware integer minor-unit financial model (ADR-0006, Database Design §3.3).
 * Never uses binary floating-point arithmetic for authoritative money calculations.
 */

export interface CurrencyDefinition {
  code: string;
  name: string;
  symbol: string;
  exponent: number; // e.g., 2 for BDT (poisha), 2 for USD (cents), 0 for JPY
  is_active: boolean;
}

export const CURRENCY_REGISTRY: Readonly<Record<string, CurrencyDefinition>> = {
  BDT: {
    code: "BDT",
    name: "Bangladeshi Taka",
    symbol: "৳",
    exponent: 2,
    is_active: true,
  },
  USD: {
    code: "USD",
    name: "US Dollar",
    symbol: "$",
    exponent: 2,
    is_active: true,
  },
  EUR: {
    code: "EUR",
    name: "Euro",
    symbol: "€",
    exponent: 2,
    is_active: true,
  },
  GBP: {
    code: "GBP",
    name: "British Pound",
    symbol: "£",
    exponent: 2,
    is_active: true,
  },
  JPY: {
    code: "JPY",
    name: "Japanese Yen",
    symbol: "¥",
    exponent: 0,
    is_active: false,
  },
};

export function getCurrencyDefinition(currencyCode: string): CurrencyDefinition {
  const normalized = currencyCode.trim().toUpperCase();
  const def = CURRENCY_REGISTRY[normalized];
  if (!def) {
    throw new Error(`Unsupported currency code: ${currencyCode}`);
  }
  return def;
}

export function assertValidMinorAmount(amountMinor: number, allowZero = true): void {
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor)) {
    throw new Error("Monetary amount_minor must be a safe integer.");
  }
  if (allowZero ? amountMinor < 0 : amountMinor <= 0) {
    throw new Error(allowZero ? "Monetary amount cannot be negative." : "Monetary amount must be positive.");
  }
}

export function assertSameCurrency(currencyA: string, currencyB: string): string {
  const a = getCurrencyDefinition(currencyA).code;
  const b = getCurrencyDefinition(currencyB).code;
  if (a !== b) {
    throw new Error(`Currency mismatch: cannot combine ${a} and ${b} without explicit conversion.`);
  }
  return a;
}

export interface LinePricingInput {
  unit_amount_minor: number;
  quantity: number;
  line_discount_minor?: number;
  line_tax_minor?: number;
  currency_code: string;
}

export interface LinePricingResult {
  currency_code: string;
  unit_amount_minor: number;
  quantity: number;
  line_subtotal_minor: number;
  line_discount_minor: number;
  line_tax_minor: number;
  line_total_minor: number;
}

export function calculateLineTotals(input: LinePricingInput): LinePricingResult {
  const currency = getCurrencyDefinition(input.currency_code);
  assertValidMinorAmount(input.unit_amount_minor, true);
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new Error("Order line quantity must be a positive integer.");
  }
  const discount = input.line_discount_minor ?? 0;
  const tax = input.line_tax_minor ?? 0;
  assertValidMinorAmount(discount, true);
  assertValidMinorAmount(tax, true);

  const subtotal = input.unit_amount_minor * input.quantity;
  if (!Number.isSafeInteger(subtotal)) {
    throw new Error("Line subtotal exceeds safe integer bounds.");
  }
  if (discount > subtotal) {
    throw new Error("Line discount cannot exceed line subtotal.");
  }
  const total = subtotal - discount + tax;
  assertValidMinorAmount(total, true);

  return {
    currency_code: currency.code,
    unit_amount_minor: input.unit_amount_minor,
    quantity: input.quantity,
    line_subtotal_minor: subtotal,
    line_discount_minor: discount,
    line_tax_minor: tax,
    line_total_minor: total,
  };
}

export interface OrderPricingSummary {
  currency_code: string;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
}

export function calculateOrderTotals(
  lines: ReadonlyArray<LinePricingResult>,
  orderLevelDiscountMinor = 0,
  orderLevelTaxMinor = 0
): OrderPricingSummary {
  if (lines.length === 0) {
    throw new Error("Order must contain at least one line item.");
  }
  const firstLine = lines[0]!;
  const currencyCode = getCurrencyDefinition(firstLine.currency_code).code;
  assertValidMinorAmount(orderLevelDiscountMinor, true);
  assertValidMinorAmount(orderLevelTaxMinor, true);

  let subtotal = 0;
  let lineDiscounts = 0;
  let lineTaxes = 0;

  for (const line of lines) {
    assertSameCurrency(currencyCode, line.currency_code);
    const verified = calculateLineTotals(line);
    if (
      verified.line_subtotal_minor !== line.line_subtotal_minor ||
      verified.line_total_minor !== line.line_total_minor
    ) {
      throw new Error("Line item totals failed integrity reconciliation.");
    }
    subtotal += verified.line_subtotal_minor;
    lineDiscounts += verified.line_discount_minor;
    lineTaxes += verified.line_tax_minor;
  }

  const totalDiscount = lineDiscounts + orderLevelDiscountMinor;
  if (totalDiscount > subtotal) {
    throw new Error("Total order discount cannot exceed order subtotal.");
  }
  const totalTax = lineTaxes + orderLevelTaxMinor;
  const total = subtotal - totalDiscount + totalTax;
  assertValidMinorAmount(total, true);

  return {
    currency_code: currencyCode,
    subtotal_minor: subtotal,
    discount_minor: totalDiscount,
    tax_minor: totalTax,
    total_minor: total,
  };
}

export function formatMinorMoney(amountMinor: number, currencyCode: string): string {
  const def = getCurrencyDefinition(currencyCode);
  assertValidMinorAmount(Math.abs(amountMinor), true);
  const sign = amountMinor < 0 ? "-" : "";
  const absVal = Math.abs(amountMinor);
  if (def.exponent === 0) {
    return `${sign}${def.symbol}${absVal.toLocaleString("en-US")}`;
  }
  const divisor = 10 ** def.exponent;
  const major = Math.floor(absVal / divisor);
  const minor = String(absVal % divisor).padStart(def.exponent, "0");
  return `${sign}${def.symbol}${major.toLocaleString("en-US")}.${minor}`;
}

export function parseMajorStringToMinor(majorInput: string, currencyCode: string): number {
  const def = getCurrencyDefinition(currencyCode);
  const trimmed = majorInput.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid monetary input '${majorInput}'.`);
  }
  const [wholePart = "0", fracPart = ""] = trimmed.split(".");
  if (fracPart.length > def.exponent) {
    throw new Error(
      `Currency ${def.code} supports at most ${def.exponent} decimal places (got '${majorInput}').`
    );
  }
  const paddedFrac = fracPart.padEnd(def.exponent, "0");
  const combined = Number(wholePart) * 10 ** def.exponent + (paddedFrac ? Number(paddedFrac) : 0);
  assertValidMinorAmount(combined, true);
  return combined;
}

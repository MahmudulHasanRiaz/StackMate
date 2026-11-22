/**
 * Date and Time Utilities implementing ADR-0001 and Section 6:
 * - User-facing date format: DD/MM/YYYY
 * - API date-only format: YYYY-MM-DD (ISO 8601)
 * - API timestamp format: YYYY-MM-DDTHH:mm:ss.sssZ (ISO 8601 UTC)
 * - Never relies on ambiguous native Date.parse("05/11/2026").
 */

const DD_MM_YYYY_REGEX = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ISO_DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function getDaysInMonth(year: number, month1To12: number): number {
  if (month1To12 < 1 || month1To12 > 12) return 0;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month1To12 - 1] ?? 0;
}

export function isValidCalendarDate(year: number, month1To12: number, day1To31: number): boolean {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return false;
  if (!Number.isInteger(month1To12) || month1To12 < 1 || month1To12 > 12) return false;
  const maxDay = getDaysInMonth(year, month1To12);
  return Number.isInteger(day1To31) && day1To31 >= 1 && day1To31 <= maxDay;
}

/**
 * Strictly parses a user-facing DD/MM/YYYY string into an ISO 8601 date-only string (YYYY-MM-DD).
 */
export function parseStrictDDMMYYYYToIsoDate(displayDate: string): string {
  const match = DD_MM_YYYY_REGEX.exec(displayDate.trim());
  if (!match) {
    throw new Error(`Invalid date format '${displayDate}'. Expected DD/MM/YYYY.`);
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) {
    throw new Error(`Invalid calendar date '${displayDate}'.`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Validates an ISO 8601 date-only string (YYYY-MM-DD).
 */
export function isValidIsoDateOnly(isoDate: string): boolean {
  const match = ISO_DATE_ONLY_REGEX.exec(isoDate.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidCalendarDate(year, month, day);
}

/**
 * Converts an ISO 8601 date-only string (YYYY-MM-DD) or ISO timestamp into user-facing DD/MM/YYYY.
 * When a timezone is provided for an instant timestamp, formats in that IANA timezone.
 * Defaults to Asia/Dhaka, the product's display timezone (LIVE L3: the
 * UTC default showed the wrong date for evening timestamps).
 */
export function formatDisplayDateDDMMYYYY(
  isoDateOrTimestamp: string | Date,
  timeZone = "Asia/Dhaka"
): string {
  if (typeof isoDateOrTimestamp === "string" && ISO_DATE_ONLY_REGEX.test(isoDateOrTimestamp.trim())) {
    const trimmed = isoDateOrTimestamp.trim();
    if (!isValidIsoDateOnly(trimmed)) {
      throw new Error(`Invalid ISO date-only value '${isoDateOrTimestamp}'.`);
    }
    const [year, month, day] = trimmed.split("-");
    return `${day}/${month}/${year}`;
  }

  const dateObj =
    isoDateOrTimestamp instanceof Date ? isoDateOrTimestamp : new Date(isoDateOrTimestamp);
  if (Number.isNaN(dateObj.getTime())) {
    throw new Error(`Invalid timestamp value '${String(isoDateOrTimestamp)}'.`);
  }

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return formatter.format(dateObj);
}

/**
 * Formats an ISO 8601 timestamp into user-facing DD/MM/YYYY HH:mm in the specified IANA timezone.
 */export function formatDisplayDateTimeDDMMYYYY(
  isoTimestamp: string | Date,
  timeZone = "Asia/Dhaka"
): string {
  const dateObj = isoTimestamp instanceof Date ? isoTimestamp : new Date(isoTimestamp);
  if (Number.isNaN(dateObj.getTime())) {
    throw new Error(`Invalid timestamp value '${String(isoTimestamp)}'.`);
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dateObj);

  const map: Record<string, string> = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  return `${map.day}/${map.month}/${map.year} ${map.hour}:${map.minute}`;
}

export function isValidIsoTimestamp(value: string): boolean {
  if (!ISO_TIMESTAMP_REGEX.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

export function toUtcIsoTimestamp(date: Date = new Date()): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error("Cannot convert invalid Date to ISO timestamp.");
  }
  return date.toISOString();
}

export type BillingIntervalUnit = "day" | "week" | "month" | "year";

export function addBillingIntervalUTC(
  startIso: string | Date,
  unit: BillingIntervalUnit,
  count: number
): string {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("Billing interval count must be a positive integer.");
  }
  const base = startIso instanceof Date ? new Date(startIso.getTime()) : new Date(startIso);
  if (Number.isNaN(base.getTime())) {
    throw new Error("Invalid start timestamp for billing interval calculation.");
  }
  const result = new Date(base.getTime());
  if (unit === "day") {
    result.setUTCDate(result.getUTCDate() + count);
  } else if (unit === "week") {
    result.setUTCDate(result.getUTCDate() + count * 7);
  } else if (unit === "month") {
    const origDay = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + count);
    const maxDay = getDaysInMonth(result.getUTCFullYear(), result.getUTCMonth() + 1);
    result.setUTCDate(Math.min(origDay, maxDay));
  } else if (unit === "year") {
    const origDay = result.getUTCDate();
    const origMonth = result.getUTCMonth();
    result.setUTCDate(1);
    result.setUTCFullYear(result.getUTCFullYear() + count);
    const maxDay = getDaysInMonth(result.getUTCFullYear(), origMonth + 1);
    result.setUTCDate(Math.min(origDay, maxDay));
  }
  return result.toISOString();
}

/**
 * Calendar date (YYYY-MM-DD) of an ISO 8601 instant in the given IANA
 * timezone. Used for inclusive day-boundary range checks: a timestamp
 * counts for a date when its calendar date *in the display timezone*
 * is within [from, to]. No UTC-offset arithmetic — Bangladesh has no
 * DST, but this stays correct for any zone.
 */
export function isoDateOnlyInTimeZone(isoTimestamp: string, timeZone: string): string {
  return parseStrictDDMMYYYYToIsoDate(formatDisplayDateDDMMYYYY(isoTimestamp, timeZone));
}

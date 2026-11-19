/**
 * Dashboard overview date range (PLAN §23).
 *
 * `GET /api/v1/admin/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * scopes the flow metrics (verified revenue, total orders, paid orders)
 * to the inclusive range. Day boundaries are the *display* timezone
 * (Asia/Dhaka, the fixed product timezone): a timestamp counts when its
 * calendar date in that zone is within [from, to]. Implemented as a
 * date-only comparison — no UTC-offset arithmetic, correct for any zone.
 *
 * Rules: both params absent = all time (null range); exactly one present,
 * bad format, from > to, or a span over 366 days → 400 VALIDATION_ERROR.
 */
import {
  isValidIsoDateOnly,
  isoDateOnlyInTimeZone,
} from "../../../../../packages/contracts/src/index.ts";
import { AppError } from "../../shared/errors.ts";

export interface OverviewRange {
  from: string;
  to: string;
}

/** Maximum custom range, in days (inclusive). All time is unbounded. */
export const OVERVIEW_RANGE_MAX_DAYS = 366;

function daysBetweenInclusive(from: string, to: string): number {
  const fromMs = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const toMs = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}

export function parseOverviewRange(searchParams: URLSearchParams): OverviewRange | null {
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (from === null && to === null) return null;
  if (from === null || to === null) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Both 'from' and 'to' are required together (YYYY-MM-DD).",
      400,
    );
  }
  if (!isValidIsoDateOnly(from) || !isValidIsoDateOnly(to)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "'from' and 'to' must be valid YYYY-MM-DD dates.",
      400,
    );
  }
  if (from > to) {
    throw new AppError("VALIDATION_ERROR", "'from' must not be after 'to'.", 400);
  }
  if (daysBetweenInclusive(from, to) > OVERVIEW_RANGE_MAX_DAYS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Date range must not exceed ${OVERVIEW_RANGE_MAX_DAYS} days.`,
      400,
    );
  }
  return { from, to };
}

/**
 * True when the timestamp falls inside the range. A null range (all time)
 * matches everything; a null/undefined/invalid timestamp matches nothing
 * inside a bounded range (e.g. an order with no completed_at never
 * counts as revenue for a bounded period).
 */
export function isTimestampInOverviewRange(
  isoTimestamp: string | null | undefined,
  range: OverviewRange | null,
  timeZone: string,
): boolean {
  if (range === null) return true;
  if (!isoTimestamp) return false;
  let day: string;
  try {
    day = isoDateOnlyInTimeZone(isoTimestamp, timeZone);
  } catch {
    return false;
  }
  return day >= range.from && day <= range.to;
}

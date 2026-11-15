import React from "react";
import { formatDisplayDateDDMMYYYY, formatMinorMoney } from "../lib/api-client.ts";

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  let variant = "sm-badge-neutral";
  if (
    normalized === "active" ||
    normalized === "published" ||
    normalized === "paid" ||
    normalized === "approved" ||
    normalized === "completed" ||
    normalized === "verified" ||
    normalized === "enabled"
  ) {
    variant = "sm-badge-success";
  } else if (
    normalized === "submitted" ||
    normalized === "under_review" ||
    normalized === "pending_verification" ||
    normalized === "awaiting_payment" ||
    normalized === "pending" ||
    normalized === "draft"
  ) {
    variant = "sm-badge-warning";
  } else if (
    normalized === "rejected" ||
    normalized === "revoked" ||
    normalized === "suspended" ||
    normalized === "expired" ||
    normalized === "cancelled" ||
    normalized === "failed"
  ) {
    variant = "sm-badge-danger";
  }
  return <span className={`sm-badge ${variant}`}>{status.replace(/_/g, " ")}</span>;
}

export function MoneyCell({
  amountMinor,
  currencyCode = "BDT",
}: {
  amountMinor: number;
  currencyCode?: string;
}) {
  return <span className="sm-tabular sm-mono">{formatMinorMoney(amountMinor, currencyCode)}</span>;
}

export function DateCell({
  isoValue,
  timeZone = "Asia/Dhaka",
}: {
  isoValue: string | null | undefined;
  timeZone?: string;
}) {
  if (!isoValue) return <span className="sm-mono">—</span>;
  return <span className="sm-mono">{formatDisplayDateDDMMYYYY(isoValue, timeZone)}</span>;
}

export function EmptyState({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      className="sm-card"
      style={{ textAlign: "center", padding: "32px 16px", color: "var(--sm-text-muted)" }}
    >
      <div style={{ fontWeight: 600, color: "var(--sm-text)", marginBottom: "12px" }}>{title}</div>
      {actionLabel && onAction ? (
        <button type="button" className="sm-btn sm-btn-primary" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

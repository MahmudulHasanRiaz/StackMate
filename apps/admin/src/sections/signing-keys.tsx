/**
 * Signing keys — license signing-key lifecycle surface (E-05, PRD §13.5).
 *
 * Route (registered in router.tsx, Settings shell): /settings/signing-keys
 *
 * Endpoints (pinned routes — the API worker implements them in parallel;
 * the store methods rotateSigningKey/revokeSigningKey already exist):
 *   GET  /api/v1/admin/licenses/signing-keys
 *   POST /api/v1/admin/licenses/signing-keys/rotate
 *   POST /api/v1/admin/licenses/signing-keys/:keyId/revoke
 *
 * The only key endpoint before this surface was the PUBLIC read
 * GET /api/v1/licenses/signing-keys. Key rotation/revocation — the
 * recovery procedure for a compromised signing key — was unreachable
 * from the admin panel. The DTO shape below is defensive: anything
 * the server does not send yet renders as "—". A 404 means the
 * endpoints are not live yet.
 */
import { useState, useMemo} from "react";
import { KeyRound } from "lucide-react";
import { ApiClientError, apiRequest } from "../lib/api-client";
import { listKey } from "../lib/query";
import {
  ListTable,
  PageHeader,
  parseListSearch,
  useAdminList,
  useAdminMutation,
  useIdempotencyKey,
} from "../lib/section-kit";
import {
  Alert,
  Button,
  DateTimeCell,
  StatusBadge,
  useConfirm,
} from "../components/primitives";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate, useSearch } from "@tanstack/react-router";

export interface SigningKey {
  id: string;
  /** Key id / kid. */
  key_id?: string | null;
  status: string;
  created_at: string | null;
  rotated_at?: string | null;
  revoked_at?: string | null;
  /** Whether this key currently signs new entitlement tokens. */
  is_current?: boolean | null;
}

export function SigningKeysSection() {
  const rawSearch = useSearch({ strict: false }) as unknown as Record<string, unknown>;
  const search = parseListSearch(rawSearch);
  const navigate = useNavigate();
  const setSearch = (patch: Record<string, string | number | undefined>) => {
    const next: Record<string, unknown> = {
      q: search.q,
      page: search.page,
      pageSize: search.pageSize,
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    void navigate({ to: "/settings/signing-keys", search: next } as never);
  };
  const confirm = useConfirm();
  const rotateKey = useIdempotencyKey();
  const [rotated, setRotated] = useState<SigningKey | null>(null);

  const query = useAdminList<SigningKey>(
    "signing-keys",
    "/api/v1/admin/licenses/signing-keys",
    { q: search.q, page: search.page, pageSize: search.pageSize },
  );

  const notLive =
    query.isError &&
    query.error instanceof ApiClientError &&
    query.error.statusCode === 404;

  const rotate = useAdminMutation<SigningKey, void>({
    mutationFn: () =>
      apiRequest<SigningKey>("/api/v1/admin/licenses/signing-keys/rotate", {
        method: "POST",
        body: JSON.stringify({}),
        idempotencyKey: rotateKey,
      }),
    invalidateKeys: [listKey("signing-keys")],
    successTitle: "Signing key rotated",
    successMessage: "New entitlements are signed with the new key.",
    onSuccess: (data) => setRotated(data),
  });

  // A-04: one key per section instance — a retried revoke replays.
  const revokeKey = useIdempotencyKey();
  const revoke = useAdminMutation<SigningKey, string>({
    mutationFn: (keyId) =>
      apiRequest<SigningKey>(
        `/api/v1/admin/licenses/signing-keys/${keyId}/revoke`,
        { method: "POST", body: JSON.stringify({}), idempotencyKey: revokeKey },
      ),
    invalidateKeys: [listKey("signing-keys")],
    successTitle: "Signing key revoked",
  });

  const askRotate = async () => {
    const ok = await confirm({
      title: "Rotate the signing key?",
      body: "A new key becomes the current signing key. Old keys keep verifying already-issued tokens until they are revoked.",
      confirmLabel: "Rotate key",
    });
    if (ok) rotate.mutate();
  };

  const askRevoke = async (key: SigningKey) => {
    const ok = await confirm({
      title: "Revoke this signing key?",
      body: `Key ${key.key_id ?? key.id} will stop verifying tokens. This cannot be undone — only revoke a key you are sure is compromised or fully retired.`,
      confirmLabel: "Revoke key",
      danger: true,
      warning: "Revoking a key invalidates every token it signed.",
    });
    if (ok) revoke.mutate(key.id);
  };

  const columns: ColumnDef<SigningKey, unknown>[] = useMemo(
    () => [
      {
        accessorKey: "key_id",
        header: "Key",
        cell: ({ row }) => (
          <span className="sm-mono">
            {row.original.key_id ?? row.original.id}
            {row.original.is_current ? (
              <span className="sm-hint"> (current)</span>
            ) : null}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }) => <DateTimeCell value={row.original.created_at} />,
      },
      {
        accessorKey: "rotated_at",
        header: "Rotated",
        cell: ({ row }) => <DateTimeCell value={row.original.rotated_at ?? null} />,
      },
      {
        accessorKey: "revoked_at",
        header: "Revoked",
        cell: ({ row }) => <DateTimeCell value={row.original.revoked_at ?? null} />,
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.status === "revoked" ? (
            "—"
          ) : (
            <Button
              variant="danger-ghost"
              size="sm"
              disabled={revoke.isPending}
              loading={revoke.isPending && revoke.variables === row.original.id}
              onClick={() => void askRevoke(row.original)}
            >
              Revoke
            </Button>
          ),
      },
  ],
    [revoke],
  )

  return (
    <section aria-labelledby="signing-keys-heading">
      <PageHeader
        breadcrumb={[{ label: "Settings" }, { label: "Signing Keys" }]}
        title="Signing Keys"
        help="License entitlement signing keys — rotate after a suspected compromise, revoke a retired key"
        action={
          <Button variant="primary" loading={rotate.isPending} onClick={() => void askRotate()}>
            Rotate key
          </Button>
        }
      />
      {notLive ? (
        <Alert variant="warning">
          The signing-key admin endpoints are not available yet — key
          rotation and revocation are being built on the API side. The
          public key list still works for license clients.
        </Alert>
      ) : null}
      {rotated ? (
        <Alert variant="success">
          Rotated — the current signing key is now{" "}
          <span className="sm-mono">{rotated.key_id ?? rotated.id}</span>.
        </Alert>
      ) : null}
      <ListTable<SigningKey>
        columns={columns}
        data={query.data}
        serverSearch
        serverPagination
        refreshSection="signing-keys"
        total={query.total}
        search={search.q ?? ""}
        onSearchChange={(q) => setSearch({ q: q || undefined, page: 1 })}
        page={search.page ?? 1}
        onPageChange={(page) => setSearch({ page })}
        pageSize={search.pageSize ?? 25}
        onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
        isLoading={query.isPending}
        isError={query.isError && !notLive}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyIcon={KeyRound}
        emptyTitle="No signing keys"
        emptyBody="No signing keys are registered."
        getRowId={(row) => row.id}
      />
    </section>
  );
}

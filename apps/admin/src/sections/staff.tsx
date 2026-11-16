/**
 * Staff & Roles — Administration (PRD §2.1, API Spec §8).
 *
 * One route with three tabs: Users | Roles | Invitations.
 *
 * Endpoints (all gated by `users.manage` unless noted):
 *  - GET  /api/v1/admin/users                        list staff users (embeds role keys)
 *  - GET  /api/v1/admin/users/:id                    staff user detail (embeds role keys)
 *  - PUT  /api/v1/admin/users/:userId/roles          replace a user's role keys
 *  - GET  /api/v1/admin/roles                        list roles
 *  - POST /api/v1/admin/roles                        create role (body `permissions`, NOT
 *                                                    permission_keys; `super_admin` key reserved, 409)
 *  - PATCH /api/v1/admin/roles/:roleId               update role (super_admin unmodifiable, 403;
 *                                                    system-role permissions unchangeable, 409)
 *  - GET  /api/v1/admin/permissions                  permission catalogue (no gate)
 *  - GET  /api/v1/admin/users/invitations            list invitations (token_hash stripped)
 *  - POST /api/v1/admin/users/invitations            create invitation; returns
 *                                                    { invitation, token_once } — the token is
 *                                                    shown ONCE, no email is sent anywhere
 *  - POST /api/v1/admin/users/invitations/:id/revoke revoke a pending invitation
 *
 * Documented divergence (API Spec §8 vs seed catalogue): the spec names
 * users.invite / roles.create / roles.update, but those permission keys DO
 * NOT exist in the seeded catalogue — the existing `users.manage` gate is
 * used as the equivalent for all role + invitation writes. No new
 * permission keys are invented here.
 *
 * Known server gap, surfaced not hidden: invitation create/revoke return
 * 503 on the DrizzleStore until the Batch 1 staff_invitations wiring patch
 * lands (they work on the in-memory store). The server's message is shown
 * via the mutation error toast; the invitations list itself still loads.
 */
import { useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  KeyRound,
  MailPlus,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { apiRequest } from "../lib/api-client";
import { listKey } from "../lib/query";
import { useAuth } from "../components/shell";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  CopyButton,
  DateCell,
  DateTimeCell,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  StatusBadge,
  Tabs,
  Textarea,
  useConfirm,
} from "../components/primitives";
import {
  DetailFacts,
  DetailLayout,
  ListTable,
  PageHeader,
  apiErrorMessage,
  parseListSearch,
  useAdminDetail,
  useAdminList,
  useAdminMutation,
} from "../lib/section-kit";

/* Field's `error?: string` is under exactOptionalPropertyTypes, so an
 * explicitly-undefined error must be omitted, not passed. */
const fieldError = (message?: string) =>
  message ? { error: message } : {};

/* ------------------------------------------------------------------ */
/* Record shapes (mirror apps/api/src/platform/db/store.ts)            */
/* ------------------------------------------------------------------ */
interface StaffUser {
  id: string;
  name: string;
  email: string;
  status: "active" | "suspended";
  roles: string[];
  created_at: string;
  created_date_display?: string;
}

interface Role {
  id: string;
  key: string;
  name: string;
  description: string;
  is_system: boolean;
  permission_keys: string[];
  created_at: string;
}

interface PermissionItem {
  id?: string;
  key: string;
  description: string;
}

interface StaffInvitation {
  id: string;
  email: string;
  name: string;
  role_keys: string[];
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  invited_by_user_id: string | null;
  accepted_user_id: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CreateInvitationResult {
  invitation: StaffInvitation;
  token_once: string;
}

type TabKey = "users" | "roles" | "invitations";

const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function roleKeysLabel(keys: string[]): string {
  return keys.length > 0 ? keys.join(", ") : "—";
}

/* ------------------------------------------------------------------ */
/* StaffSection — /staff                                               */
/* ------------------------------------------------------------------ */
export function StaffSection() {
  const [tab, setTab] = useState<TabKey>("users");
  const { principal } = useAuth();
  const isSuperAdmin = principal.roles.includes("super_admin");
  const confirm = useConfirm();

  /* Users list — URL-backed search/page (route /staff).
   * The route's id is "/_main/staff" (the operational shell is a
   * pathless `_main` layout route), so a plain-path `from: "/staff"`
   * hook throws "Invariant failed" at render (jsdom repro 2026-11-15).
   * Like the other list sections, read the current route's search with
   * `strict: false` and navigate without `from`. */
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const listSearch = parseListSearch(rawSearch as Record<string, unknown>);
  const navigate = useNavigate();
  const setListSearch = (patch: {
    q?: string | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
  }) =>
    void navigate({
      search: (prev: Record<string, unknown>) => ({
        ...(prev as Record<string, unknown>),
        ...patch,
      }),
      replace: true,
    } as never);

  /* Roles + invitations lists — local search/page (ListTable owns them). */
  const [rolesSearch, setRolesSearch] = useState("");
  const [rolesPage, setRolesPage] = useState(1);
  const [rolesPageSize, setRolesPageSize] = useState(25);
  const [invSearch, setInvSearch] = useState("");
  const [invPage, setInvPage] = useState(1);
  const [invPageSize, setInvPageSize] = useState(25);
  const [userStatus, setUserStatus] = useState<"all" | "active" | "suspended">("all");
  const [invStatus, setInvStatus] = useState<
    "all" | "pending" | "accepted" | "revoked" | "expired"
  >("all");

  const usersQuery = useAdminList<StaffUser>("staff-users", "/api/v1/admin/users");
  const rolesQuery = useAdminList<Role>("staff-roles", "/api/v1/admin/roles");
  const permissionsQuery = useAdminList<PermissionItem>(
    "staff-permissions",
    "/api/v1/admin/permissions",
  );
  const invitationsQuery = useAdminList<StaffInvitation>(
    "staff-invitations",
    "/api/v1/admin/users/invitations",
  );

  /* ---- Role dialog state ---- */
  const [roleDialog, setRoleDialog] = useState<
    { mode: "create" } | { mode: "edit"; role: Role } | null
  >(null);
  const [roleKey, setRoleKey] = useState("");
  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [rolePermissions, setRolePermissions] = useState<string[]>([]);
  const [roleErrors, setRoleErrors] = useState<{
    key?: string;
    name?: string;
    description?: string;
    permissions?: string;
  }>({});

  const openCreateRole = () => {
    setRoleKey("");
    setRoleName("");
    setRoleDescription("");
    setRolePermissions([]);
    setRoleErrors({});
    setRoleDialog({ mode: "create" });
  };
  const openEditRole = (role: Role) => {
    setRoleKey(role.key);
    setRoleName(role.name);
    setRoleDescription(role.description);
    setRolePermissions([...role.permission_keys]);
    setRoleErrors({});
    setRoleDialog({ mode: "edit", role });
  };

  const createRole = useAdminMutation<Role, { key: string; name: string; description?: string; permissions: string[] }>({
    mutationFn: (body) =>
      apiRequest<Role>("/api/v1/admin/roles", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("staff-roles")],
    successTitle: "Role created",
    successMessage: "The role is available for staff users and invitations.",
    onSuccess: () => setRoleDialog(null),
  });
  const updateRole = useAdminMutation<Role, { id: string; name: string; description?: string; permissions?: string[] }>({
    mutationFn: (body) =>
      apiRequest<Role>(`/api/v1/admin/roles/${body.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: body.name,
          description: body.description,
          ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
        }),
      }),
    invalidateKeys: [listKey("staff-roles")],
    successTitle: "Role updated",
    onSuccess: () => setRoleDialog(null),
  });

  const validateRoleForm = (): boolean => {
    const errors: typeof roleErrors = {};
    if (roleDialog?.mode === "create") {
      if (roleKey.trim().length < 2 || roleKey.trim().length > 60) {
        errors.key = "Role key must be 2–60 characters.";
      } else if (!ROLE_KEY_PATTERN.test(roleKey.trim())) {
        errors.key = "Use snake_case starting with a lowercase letter.";
      } else if (roleKey.trim() === "super_admin") {
        errors.key = "Role key 'super_admin' is reserved.";
      }
    }
    if (roleName.trim().length < 2 || roleName.trim().length > 160) {
      errors.name = "Name must be 2–160 characters.";
    }
    if (roleDescription.trim().length > 500) {
      errors.description = "Description must be at most 500 characters.";
    }
    setRoleErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const submitRole = () => {
    if (!roleDialog || !validateRoleForm()) return;
    if (roleDialog.mode === "create") {
      createRole.mutate({
        key: roleKey.trim().toLowerCase(),
        name: roleName.trim(),
        ...(roleDescription.trim()
          ? { description: roleDescription.trim() }
          : {}),
        permissions: rolePermissions,
      });
    } else {
      const systemLocked = roleDialog.role.is_system;
      updateRole.mutate({
        id: roleDialog.role.id,
        name: roleName.trim(),
        description: roleDescription.trim(),
        ...(systemLocked ? {} : { permissions: rolePermissions }),
      });
    }
  };

  const editingRole = roleDialog?.mode === "edit" ? roleDialog.role : null;
  const rolePermissionsLocked = editingRole?.is_system ?? false;

  /* ---- Invitation dialog state ---- */
  const [inviteDialog, setInviteDialog] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoles, setInviteRoles] = useState<string[]>([]);
  const [inviteErrors, setInviteErrors] = useState<{
    name?: string;
    email?: string;
    roles?: string;
  }>({});
  const [tokenResult, setTokenResult] = useState<CreateInvitationResult | null>(null);

  const openInvite = () => {
    setInviteName("");
    setInviteEmail("");
    setInviteRoles([]);
    setInviteErrors({});
    setInviteDialog(true);
  };

  const createInvitation = useAdminMutation<
    CreateInvitationResult,
    { name: string; email: string; role_keys: string[] }
  >({
    mutationFn: (body) =>
      apiRequest<CreateInvitationResult>("/api/v1/admin/users/invitations", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidateKeys: [listKey("staff-invitations")],
    successTitle: "Invitation created",
    successMessage: "Share the one-time token with the invitee — it is shown once.",
    onSuccess: (data) => {
      setInviteDialog(false);
      setTokenResult(data);
    },
  });

  const submitInvitation = () => {
    const errors: typeof inviteErrors = {};
    if (inviteName.trim().length < 2 || inviteName.trim().length > 200) {
      errors.name = "Name must be 2–200 characters.";
    }
    if (!EMAIL_PATTERN.test(inviteEmail.trim())) {
      errors.email = "Enter a valid email address.";
    }
    if (inviteRoles.length === 0) {
      errors.roles = "Choose at least one role.";
    }
    setInviteErrors(errors);
    if (Object.keys(errors).length > 0) return;
    createInvitation.mutate({
      name: inviteName.trim(),
      email: inviteEmail.trim().toLowerCase(),
      role_keys: inviteRoles,
    });
  };

  const revokeInvitation = useAdminMutation<
    StaffInvitation,
    { id: string; name: string; email: string }
  >({
    mutationFn: (body) =>
      apiRequest<StaffInvitation>(
        `/api/v1/admin/users/invitations/${body.id}/revoke`,
        { method: "POST" },
      ),
    invalidateKeys: [listKey("staff-invitations")],
    successTitle: "Invitation revoked",
  });

  const onRevoke = async (inv: StaffInvitation) => {
    const ok = await confirm({
      title: "Revoke invitation?",
      body: (
        <div>
          <p>
            The invitation for {inv.name} ({inv.email}) stops working
            immediately.
          </p>
          <p>
            The invitee cannot use it to create an account. You can invite
            them again afterwards.
          </p>
        </div>
      ),
      confirmLabel: "Revoke",
      danger: true,
    });
    if (ok) revokeInvitation.mutate({ id: inv.id, name: inv.name, email: inv.email });
  };

  const toggleIn = (list: string[], key: string): string[] =>
    list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const permissions = useMemo(
    () => permissionsQuery.data ?? [],
    [permissionsQuery.data],
  );
  const filteredUsers = useMemo(
    () =>
      userStatus === "all"
        ? usersQuery.data
        : usersQuery.data?.filter((u) => u.status === userStatus),
    [usersQuery.data, userStatus],
  );
  const filteredInvitations = useMemo(
    () =>
      invStatus === "all"
        ? invitationsQuery.data
        : invitationsQuery.data?.filter((i) => i.status === invStatus),
    [invitationsQuery.data, invStatus],
  );

  const userColumns = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }: { row: { original: StaffUser } }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void navigate({
                to: "/staff/$userId",
                params: { userId: row.original.id },
              } as never)
            }
          >
            {row.original.name}
          </Button>
        ),
      },
      { accessorKey: "email", header: "Email" },
      {
        accessorKey: "roles",
        header: "Roles",
        enableSorting: false,
        cell: ({ row }: { row: { original: StaffUser } }) => (
          <span className="sm-mono">{roleKeysLabel(row.original.roles)}</span>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }: { row: { original: StaffUser } }) => (
          <StatusBadge status={row.original.status} />
        ),
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }: { row: { original: StaffUser } }) => (
          <DateCell value={row.original.created_at} />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }: { row: { original: StaffUser } }) => (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void navigate({
                to: "/staff/$userId",
                params: { userId: row.original.id },
              } as never)
            }
          >
            View
          </Button>
        ),
      },
    ],
    [navigate],
  );

  const roleColumns = useMemo(
    () => [
      {
        accessorKey: "key",
        header: "Key",
        cell: ({ row }: { row: { original: Role } }) => (
          <span className="sm-mono">{row.original.key}</span>
        ),
      },
      { accessorKey: "name", header: "Name" },
      {
        accessorKey: "is_system",
        header: "Type",
        cell: ({ row }: { row: { original: Role } }) =>
          row.original.is_system ? "System" : "Custom",
      },
      {
        accessorKey: "permission_keys",
        header: "Permissions",
        enableSorting: false,
        cell: ({ row }: { row: { original: Role } }) =>
          `${row.original.permission_keys.length} permission${
            row.original.permission_keys.length === 1 ? "" : "s"
          }`,
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }: { row: { original: Role } }) => (
          <DateCell value={row.original.created_at} />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }: { row: { original: Role } }) =>
          row.original.key === "super_admin" ? (
            <span className="sm-hint">Cannot modify</span>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openEditRole(row.original)}
            >
              Edit
            </Button>
          ),
      },
    ],
    [],
  );

  const invitationColumns = useMemo(
    () => [
      { accessorKey: "name", header: "Name" },
      { accessorKey: "email", header: "Email" },
      {
        accessorKey: "role_keys",
        header: "Roles",
        enableSorting: false,
        cell: ({ row }: { row: { original: StaffInvitation } }) => (
          <span className="sm-mono">{roleKeysLabel(row.original.role_keys)}</span>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }: { row: { original: StaffInvitation } }) => (
          <StatusBadge status={row.original.status} />
        ),
      },
      {
        accessorKey: "expires_at",
        header: "Expires",
        cell: ({ row }: { row: { original: StaffInvitation } }) => (
          <DateTimeCell value={row.original.expires_at} />
        ),
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }: { row: { original: StaffInvitation } }) => (
          <DateCell value={row.original.created_at} />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }: { row: { original: StaffInvitation } }) =>
          row.original.status === "pending" ? (
            <Button
              variant="danger-ghost"
              size="sm"
              loading={revokeInvitation.isPending}
              onClick={() => void onRevoke(row.original)}
            >
              Revoke
            </Button>
          ) : (
            <span className="sm-hint">—</span>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revokeInvitation.isPending],
  );

  const headerAction =
    tab === "roles" ? (
      <Button variant="accent" icon={KeyRound} onClick={openCreateRole}>
        Create role
      </Button>
    ) : (
      <Button variant="accent" icon={UserPlus} onClick={openInvite}>
        Invite staff
      </Button>
    );

  return (
    <section aria-labelledby="staff-heading">
      <PageHeader
        breadcrumb={[{ label: "Staff & Roles" }]}
        title="Staff & Roles"
        subtitle="Staff users, roles, and invitations"
        action={headerAction}
      />
      <Tabs
        tabs={[
          { key: "users", label: "Users" },
          { key: "roles", label: "Roles" },
          { key: "invitations", label: "Invitations" },
        ]}
        active={tab}
        onChange={(key) => setTab(key as TabKey)}
      />

      {tab === "users" ? (
        <ListTable<StaffUser>
          columns={userColumns}
          data={filteredUsers}
          search={listSearch.q ?? ""}
          onSearchChange={(q) => setListSearch({ q: q || undefined, page: 1 })}
          page={listSearch.page ?? 1}
          onPageChange={(page) => setListSearch({ page })}
          pageSize={listSearch.pageSize ?? 25}
          onPageSizeChange={(pageSize) => setListSearch({ pageSize, page: 1 })}
          isLoading={usersQuery.isPending}
          isError={usersQuery.isError}
          error={usersQuery.error}
          onRetry={() => void usersQuery.refetch()}
          emptyIcon={Users}
          emptyTitle="No staff users yet"
          emptyBody="Invite the first staff member to give them access to this admin panel."
          emptyActionLabel="Invite staff"
          onEmptyAction={openInvite}
          getRowId={(row) => row.id}
          toolbar={
            <>
              <Chip
                active={userStatus === "all"}
                onClick={() => {
                  setUserStatus("all");
                  setListSearch({ page: 1 });
                }}
              >
                All
              </Chip>
              <Chip
                active={userStatus === "active"}
                onClick={() => {
                  setUserStatus("active");
                  setListSearch({ page: 1 });
                }}
              >
                Active
              </Chip>
              <Chip
                active={userStatus === "suspended"}
                onClick={() => {
                  setUserStatus("suspended");
                  setListSearch({ page: 1 });
                }}
              >
                Suspended
              </Chip>
            </>
          }
        />
      ) : null}

      {tab === "roles" ? (
        <ListTable<Role>
          columns={roleColumns}
          data={rolesQuery.data}
          search={rolesSearch}
          onSearchChange={(q) => {
            setRolesSearch(q);
            setRolesPage(1);
          }}
          page={rolesPage}
          onPageChange={setRolesPage}
          pageSize={rolesPageSize}
          onPageSizeChange={(size) => {
            setRolesPageSize(size);
            setRolesPage(1);
          }}
          isLoading={rolesQuery.isPending}
          isError={rolesQuery.isError}
          error={rolesQuery.error}
          onRetry={() => void rolesQuery.refetch()}
          emptyIcon={ShieldCheck}
          emptyTitle="No roles yet"
          emptyBody="Create a custom role to group permissions for staff users."
          emptyActionLabel="Create role"
          onEmptyAction={openCreateRole}
          getRowId={(row) => row.id}
        />
      ) : null}

      {tab === "invitations" ? (
        <div>
          <Alert variant="info">
            No email is sent for invitations. Deliver the one-time token to the
            invitee out of band. Invitations expire after 7 days.
          </Alert>
          <ListTable<StaffInvitation>
            columns={invitationColumns}
            data={filteredInvitations}
            search={invSearch}
            onSearchChange={(q) => {
              setInvSearch(q);
              setInvPage(1);
            }}
            page={invPage}
            onPageChange={setInvPage}
            pageSize={invPageSize}
            onPageSizeChange={(size) => {
              setInvPageSize(size);
              setInvPage(1);
            }}
            isLoading={invitationsQuery.isPending}
            isError={invitationsQuery.isError}
            error={invitationsQuery.error}
            onRetry={() => void invitationsQuery.refetch()}
            emptyIcon={MailPlus}
            emptyTitle="No invitations yet"
            emptyBody="Invite a staff member — the one-time token is shown once after creating."
            emptyActionLabel="Invite staff"
            onEmptyAction={openInvite}
            getRowId={(row) => row.id}
            toolbar={
              <>
                {(
                  ["all", "pending", "accepted", "revoked", "expired"] as const
                ).map((s) => (
                  <Chip
                    key={s}
                    active={invStatus === s}
                    onClick={() => {
                      setInvStatus(s);
                      setInvPage(1);
                    }}
                  >
                    {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </Chip>
                ))}
              </>
            }
          />
        </div>
      ) : null}

      {/* ---- Create / edit role dialog ---- */}
      <Dialog
        open={roleDialog !== null}
        onClose={() => setRoleDialog(null)}
        title={roleDialog?.mode === "edit" ? "Edit role" : "Create role"}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRoleDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              loading={createRole.isPending || updateRole.isPending}
              onClick={submitRole}
            >
              {roleDialog?.mode === "edit" ? "Save changes" : "Create role"}
            </Button>
          </>
        }
      >
        {roleDialog?.mode === "create" ? (
          <Field
            label="Role key"
            required
            hint="snake_case, starts with a lowercase letter. Cannot be changed later."
            {...fieldError(roleErrors.key)}
            htmlFor="role-key"
          >
            <Input
              id="role-key"
              value={roleKey}
              aria-invalid={roleErrors.key ? true : undefined}
              onChange={(e) => setRoleKey(e.target.value)}
              placeholder="e.g. support_lead"
            />
          </Field>
        ) : (
          <Field label="Role key" htmlFor="role-key-readonly">
            <span className="sm-mono" id="role-key-readonly">
              {roleKey}
            </span>
            {editingRole?.is_system ? (
              <span className="sm-hint">
                System role — permissions cannot be changed.
              </span>
            ) : null}
          </Field>
        )}
        <Field
          label="Name"
          required
          {...fieldError(roleErrors.name)}
          htmlFor="role-name"
        >
          <Input
            id="role-name"
            value={roleName}
            aria-invalid={roleErrors.name ? true : undefined}
            onChange={(e) => setRoleName(e.target.value)}
            placeholder="e.g. Support Lead"
          />
        </Field>
        <Field
          label="Description"
          {...fieldError(roleErrors.description)}
          htmlFor="role-description"
        >
          <Textarea
            id="role-description"
            value={roleDescription}
            aria-invalid={roleErrors.description ? true : undefined}
            onChange={(e) => setRoleDescription(e.target.value)}
            placeholder="What this role is for"
          />
        </Field>
        <Field
          label="Permissions"
          hint={
            rolePermissionsLocked
              ? "System role permissions cannot be changed. Create a custom role instead."
              : "Only a Super Admin can grant the users.manage permission."
          }
          {...fieldError(roleErrors.permissions)}
        >
          {permissionsQuery.isPending ? (
            <Skeleton height={20} />
          ) : permissionsQuery.isError ? (
            <Alert variant="danger">
              Could not load permissions:{" "}
              {apiErrorMessage(permissionsQuery.error)}{" "}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void permissionsQuery.refetch()}
              >
                Retry
              </Button>
            </Alert>
          ) : (
            <div className="sm-form-grid">
              {permissions.map((p) => {
                const grantsUsersManage = p.key === "users.manage";
                const disabled =
                  rolePermissionsLocked ||
                  (grantsUsersManage && !isSuperAdmin);
                return (
                  <Checkbox
                    key={p.key}
                    label={`${p.key} — ${p.description}`}
                    checked={rolePermissions.includes(p.key)}
                    disabled={disabled}
                    onChange={() =>
                      setRolePermissions((prev) => toggleIn(prev, p.key))
                    }
                  />
                );
              })}
            </div>
          )}
        </Field>
      </Dialog>

      {/* ---- Invite staff dialog ---- */}
      <Dialog
        open={inviteDialog}
        onClose={() => setInviteDialog(false)}
        title="Invite staff"
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setInviteDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              loading={createInvitation.isPending}
              onClick={submitInvitation}
            >
              Create invitation
            </Button>
          </>
        }
      >
        <Field
          label="Name"
          required
          {...fieldError(inviteErrors.name)}
          htmlFor="invite-name"
        >
          <Input
            id="invite-name"
            value={inviteName}
            aria-invalid={inviteErrors.name ? true : undefined}
            onChange={(e) => setInviteName(e.target.value)}
            placeholder="Full name"
          />
        </Field>
        <Field
          label="Email"
          required
          {...fieldError(inviteErrors.email)}
          htmlFor="invite-email"
        >
          <Input
            id="invite-email"
            type="email"
            value={inviteEmail}
            aria-invalid={inviteErrors.email ? true : undefined}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="name@example.com"
          />
        </Field>
        <Field
          label="Roles"
          required
          hint="Only a Super Admin can invite someone as super_admin."
          {...fieldError(inviteErrors.roles)}
        >
          {rolesQuery.isPending ? (
            <Skeleton height={20} />
          ) : rolesQuery.isError ? (
            <Alert variant="danger">
              Could not load roles: {apiErrorMessage(rolesQuery.error)}{" "}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void rolesQuery.refetch()}
              >
                Retry
              </Button>
            </Alert>
          ) : (
            <div className="sm-form-grid">
              {roles.map((r) => (
                <Checkbox
                  key={r.id}
                  label={`${r.name} (${r.key})`}
                  checked={inviteRoles.includes(r.key)}
                  disabled={r.key === "super_admin" && !isSuperAdmin}
                  onChange={() =>
                    setInviteRoles((prev) => toggleIn(prev, r.key))
                  }
                />
              ))}
            </div>
          )}
        </Field>
        {createInvitation.isError ? (
          <Alert variant="danger">
            {apiErrorMessage(createInvitation.error)}
          </Alert>
        ) : null}
      </Dialog>

      {/* ---- One-time invitation token (shown once) ---- */}
      <Dialog
        open={tokenResult !== null}
        onClose={() => setTokenResult(null)}
        title="Invitation created"
        footer={
          <Button variant="secondary" onClick={() => setTokenResult(null)}>
            Done
          </Button>
        }
      >
        {tokenResult ? (
          <div>
            <Alert variant="warning">
              Share this token with {tokenResult.invitation.name} out of band —
              it is shown once and cannot be recovered. No email is sent.
            </Alert>
            <Field label="One-time invitation token" htmlFor="invite-token">
              <span className="sm-mono" id="invite-token">
                {tokenResult.token_once}
              </span>
              <span>
                <CopyButton
                  value={tokenResult.token_once}
                  label="Copy invitation token"
                />
              </span>
            </Field>
            <DetailFacts
              facts={[
                { label: "Name", value: tokenResult.invitation.name },
                { label: "Email", value: tokenResult.invitation.email },
                {
                  label: "Roles",
                  value: roleKeysLabel(tokenResult.invitation.role_keys),
                },
                {
                  label: "Expires",
                  value: (
                    <DateTimeCell value={tokenResult.invitation.expires_at} />
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* StaffUserDetailSection — /staff/$userId                              */
/* ------------------------------------------------------------------ */
export function StaffUserDetailSection({ id }: { id: string }) {
  const { principal } = useAuth();
  const isSuperAdmin = principal.roles.includes("super_admin");
  const confirm = useConfirm();

  const detailQuery = useAdminDetail<StaffUser>(
    "staff-users",
    id,
    `/api/v1/admin/users/${id}`,
  );
  const rolesQuery = useAdminList<Role>("staff-roles", "/api/v1/admin/roles");

  /* Draft role selection; null = follow the server value. */
  const [draftRoles, setDraftRoles] = useState<string[] | null>(null);
  const user = detailQuery.data;
  const currentRoles = draftRoles ?? user?.roles ?? [];
  const rolesChanged =
    !!user &&
    (currentRoles.length !== user.roles.length ||
      currentRoles.some((k) => !user.roles.includes(k)));

  const updateRoles = useAdminMutation<
    { user_id: string; roles: string[]; revoked_sessions: number },
    { role_keys: string[] }
  >({
    mutationFn: (body) =>
      apiRequest<{ user_id: string; roles: string[]; revoked_sessions: number }>(
        `/api/v1/admin/users/${id}/roles`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    invalidateKeys: [listKey("staff-users")],
    successTitle: "Roles updated",
    successMessage:
      "The user's active sessions were signed out immediately.",
    onSuccess: () => setDraftRoles(null),
  });

  const saveRoles = async () => {
    if (!user || !rolesChanged) return;
    const ok = await confirm({
      title: "Save role changes?",
      body: (
        <div>
          <p>
            {user.name}&apos;s roles change to:{" "}
            {currentRoles.length > 0 ? currentRoles.join(", ") : "no roles"}.
          </p>
          <p>
            Saving signs {user.name} out of all active sessions immediately.
          </p>
        </div>
      ),
      confirmLabel: "Save roles",
    });
    if (ok) updateRoles.mutate({ role_keys: currentRoles });
  };

  const roles = rolesQuery.data ?? [];

  return (
    <section aria-labelledby="staff-user-heading">
      <PageHeader
        breadcrumb={[
          { label: "Staff & Roles", href: "/staff" },
          { label: user ? user.name : id },
        ]}
        title={user ? user.name : "Staff user"}
        subtitle="Staff user detail"
      />
      {detailQuery.isPending ? (
        <div className="sm-card">
          <Skeleton height={20} width="40%" />
          <div className="sm-form-grid">
            <Skeleton height={20} />
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        </div>
      ) : detailQuery.isError ? (
        <div className="sm-table-wrap">
          <ErrorState
            message={apiErrorMessage(detailQuery.error)}
            onRetry={() => void detailQuery.refetch()}
          />
        </div>
      ) : user ? (
        <DetailLayout
          title="User"
          facts={[
            { label: "Name", value: user.name },
            { label: "Email", value: user.email },
            {
              label: "Status",
              value: <StatusBadge status={user.status} />,
            },
            {
              label: "Roles",
              value: (
                <span className="sm-mono">{roleKeysLabel(user.roles)}</span>
              ),
            },
            {
              label: "Created",
              value: <DateCell value={user.created_at} />,
            },
            { label: "User ID", value: <span className="sm-mono">{user.id}</span> },
          ]}
        >
          <Card
            title="Roles"
            actions={
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!rolesChanged || updateRoles.isPending}
                  onClick={() => setDraftRoles(null)}
                >
                  Reset
                </Button>{" "}
                <Button
                  variant="accent"
                  size="sm"
                  disabled={!rolesChanged}
                  loading={updateRoles.isPending}
                  onClick={() => void saveRoles()}
                >
                  Save roles
                </Button>
              </div>
            }
          >
            {rolesQuery.isPending ? (
              <Skeleton height={20} />
            ) : rolesQuery.isError ? (
              <ErrorState
                message={apiErrorMessage(rolesQuery.error)}
                onRetry={() => void rolesQuery.refetch()}
              />
            ) : roles.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="No roles defined"
                body="Create a role first, then assign it here."
              />
            ) : (
              <div>
                <p className="sm-hint">
                  Saving new roles signs this user out of all active sessions
                  immediately.
                </p>
                <div className="sm-form-grid">
                  {roles.map((r) => (
                    <Checkbox
                      key={r.id}
                      label={`${r.name} (${r.key})`}
                      checked={currentRoles.includes(r.key)}
                      disabled={r.key === "super_admin" && !isSuperAdmin}
                      onChange={() =>
                        setDraftRoles((prev) => {
                          const base = prev ?? user.roles;
                          return base.includes(r.key)
                            ? base.filter((k) => k !== r.key)
                            : [...base, r.key];
                        })
                      }
                    />
                  ))}
                </div>
                {updateRoles.isError ? (
                  <Alert variant="danger">
                    {apiErrorMessage(updateRoles.error)}
                  </Alert>
                ) : null}
              </div>
            )}
          </Card>
        </DetailLayout>
      ) : null}
    </section>
  );
}

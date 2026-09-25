"use client";

import {
  Globe,
  Link as LinkIcon,
  Loader2,
  Lock,
  LogOut,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { NoteMenu } from "@/components/note-menu";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  addMember,
  type DirectoryHit,
  listMembers,
  type Member,
  type MemberRole,
  type MembersResponse,
  type OrgAccess,
  type PendingInvite,
  removeMember,
  revokeInvitation,
  searchDirectory,
  setOrgAccess,
  type ShareRole,
  updateMemberRole,
} from "@/lib/api";
import { useCopyLink } from "@/lib/use-copy-link";
import { cn } from "@/lib/utils";

// Owns the ShareDialog's open state (which workspace is being shared) and
// renders it. Mounted once in (app)/layout.tsx. The sidebar's workspace menu
// calls openShare(project). Mirrors SettingsProvider / SearchProvider.
type ShareTarget = { id: string; name: string; org_access?: OrgAccess };
type ShareCtx = { openShare: (project: ShareTarget) => void };
const Ctx = createContext<ShareCtx | null>(null);

export function useShare() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useShare must be used within ShareDialogProvider");
  return ctx;
}

export function ShareDialogProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ShareTarget | null>(null);
  const value = useMemo(() => ({ openShare: setTarget }), []);
  return (
    <Ctx.Provider value={value}>
      {children}
      <ShareDialog
        target={target}
        open={target !== null}
        onClose={() => setTarget(null)}
      />
    </Ctx.Provider>
  );
}

// A loose email check — the backend is the real authority (it only adds/keeps
// invites for addresses that resolve or sign in).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ShareDialog({
  target,
  open,
  onClose,
}: {
  target: ShareTarget | null;
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<MembersResponse | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [access, setAccess] = useState<OrgAccess>("none");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const copyLink = useCopyLink();

  const projectId = target?.id ?? null;

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      setData(await listMembers(projectId));
    } catch {
      setError(true);
    }
  }, [projectId]);

  // Load members + the current user's id (to tag "you" / allow Leave) on open.
  useEffect(() => {
    if (!open || !projectId) return;
    setData(null);
    setError(false);
    setAccess(target?.org_access ?? "none");
    setLoading(true);
    Promise.all([
      listMembers(projectId),
      fetch("/api/me").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([members, me]) => {
        setData(members);
        setMeId(me?.user?.id ?? null);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
    // org_access is read to seed local `access`; it only ever changes together
    // with projectId (both come from `target`), so it never re-runs on its own.
  }, [open, projectId, target?.org_access]);

  const isOwner = data?.your_role === "owner";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-lg"
      title={
        <span className="flex items-center gap-2">
          <Users size={16} className="text-muted-foreground" />
          {/* Non-owners can only view: title it "Members of" rather than "Share".
              The verb waits for data so it never flickers owner↔member. */}
          {data ? (isOwner ? "Share " : "Members of ") : ""}
          “{target?.name ?? "workspace"}”
        </span>
      }
    >
      <div className="mt-4 space-y-4">
        {isOwner && projectId && (
          <InviteComposer projectId={projectId} onInvited={refresh} />
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="py-4 text-sm text-destructive">
            Couldn’t load members.
          </div>
        ) : data && projectId ? (
          <>
            <MemberList
              projectId={projectId}
              data={data}
              meId={meId}
              isOwner={!!isOwner}
              onChange={refresh}
              onLeft={onClose}
            />
            <GeneralAccess
              projectId={projectId}
              value={access}
              canEdit={!!isOwner}
              onChange={setAccess}
            />
          </>
        ) : null}
      </div>

      {/* Drive-style footer: the workspace link, then Done. The link grants no
          access — it opens the workspace page for members (or anyone in the
          org when it's org-visible). */}
      <div className="mt-5 flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => projectId && void copyLink("project", projectId)}
          disabled={!projectId}
        >
          <LinkIcon size={14} />
          Copy link
        </Button>
        <Button size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}

// ── General access (org-wide visibility) ────────────────────

function GeneralAccess({
  projectId,
  value,
  canEdit,
  onChange,
}: {
  projectId: string;
  value: OrgAccess;
  canEdit: boolean;
  onChange: (v: OrgAccess) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const isOrg = value === "viewer";

  async function set(v: OrgAccess) {
    if (v === value || busy) return;
    setBusy(true);
    try {
      await setOrgAccess(projectId, v);
      onChange(v);
      toast(
        v === "viewer"
          ? "Anyone in the organisation can now view this workspace."
          : "Workspace is now restricted to its members.",
      );
    } catch {
      toast("Couldn’t change access.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground">
          {isOrg ? <Globe size={15} /> : <Lock size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">General access</div>
          <div className="text-xs text-muted-foreground">
            {isOrg
              ? "Anyone in the organisation can view"
              : "Restricted — only invited members"}
          </div>
        </div>
      </div>
      {canEdit ? (
        <div className="flex h-8 shrink-0 items-center gap-0.5 self-start rounded-md border p-0.5 sm:self-auto">
          {(
            [
              ["none", "Restricted"],
              ["viewer", "Organisation"],
            ] as [OrgAccess, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => void set(v)}
              aria-pressed={value === v}
              disabled={busy}
              className={cn(
                "rounded-sm px-2 py-1 text-xs transition-colors",
                value === v
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Invite composer (owner only) ────────────────────────────

function InviteComposer({
  projectId,
  onInvited,
}: {
  projectId: string;
  onInvited: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<ShareRole>("editor");
  const [hits, setHits] = useState<DirectoryHit[]>([]);
  const [showHits, setShowHits] = useState(false);
  const [picked, setPicked] = useState<DirectoryHit | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced directory typeahead; suspended once a person is picked (the input
  // then shows their name, not a search term).
  useEffect(() => {
    if (picked) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      searchDirectory(q)
        .then((res) => {
          setHits(res.results);
          setShowHits(res.results.length > 0);
        })
        .catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query, picked]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node))
        setShowHits(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Who to invite: a picked directory hit, else a typed email address.
  const typed = query.trim().toLowerCase();
  const invitee = picked?.upn ?? (EMAIL_RE.test(typed) ? typed : null);

  function pick(h: DirectoryHit) {
    setPicked(h);
    setQuery(h.name || h.upn);
    setShowHits(false);
  }

  async function invite() {
    if (!invitee || busy) return;
    setBusy(true);
    try {
      const res = await addMember(projectId, invitee, role);
      toast(
        res.kind === "member"
          ? `Added ${invitee}.`
          : `Invited ${invitee} — access begins at their next sign-in.`,
      );
      setPicked(null);
      setQuery("");
      setHits([]);
      await onInvited();
    } catch {
      toast("Couldn’t share with that address.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={boxRef} className="relative flex flex-col gap-2 sm:flex-row sm:items-start">
      <div className="relative min-w-0 flex-1">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (picked) setPicked(null);
          }}
          onFocus={() => hits.length > 0 && setShowHits(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void invite();
            }
          }}
          placeholder="Name or name@company.com"
          className="h-9 w-full rounded-md border bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-primary"
        />
        {showHits && hits.length > 0 && (
          <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border bg-background p-1 shadow-md">
            {hits.map((h) => (
              <button
                key={h.oid}
                type="button"
                onClick={() => pick(h)}
                className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-accent"
              >
                <span className="text-sm text-foreground">{h.name}</span>
                <span className="text-xs text-muted-foreground">{h.upn}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* On mobile the input takes its own row; role + Invite share the next. */}
      <div className="flex items-center justify-between gap-2">
        <RoleToggle value={role} onChange={setRole} />
        <button
          type="button"
          onClick={() => void invite()}
          disabled={!invitee || busy}
          className={cn(
            "flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground",
            (!invitee || busy) && "cursor-not-allowed opacity-50",
          )}
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <UserPlus size={14} />
          )}
          Invite
        </button>
      </div>
    </div>
  );
}

function RoleToggle({
  value,
  onChange,
}: {
  value: ShareRole;
  onChange: (r: ShareRole) => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 rounded-md border p-0.5">
      {(["editor", "viewer"] as ShareRole[]).map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          aria-pressed={value === r}
          className={cn(
            "rounded-sm px-2 py-1 text-xs capitalize transition-colors",
            value === r
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

// ── Members + pending invitations ───────────────────────────

function MemberList({
  projectId,
  data,
  meId,
  isOwner,
  onChange,
  onLeft,
}: {
  projectId: string;
  data: MembersResponse;
  meId: string | null;
  isOwner: boolean;
  onChange: () => Promise<void>;
  onLeft: () => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const ownerCount = data.members.filter((m) => m.role === "owner").length;

  async function changeRole(m: Member, role: MemberRole) {
    try {
      await updateMemberRole(projectId, m.user_id, role);
      await onChange();
    } catch {
      toast("Couldn’t change role.", "error");
    }
  }

  async function remove(m: Member) {
    const isSelf = m.user_id === meId;
    const who = m.display_name || m.upn;
    const ok = await confirm({
      title: isSelf ? "Leave this workspace?" : `Remove ${who}?`,
      description: isSelf
        ? "You’ll lose access until someone invites you again."
        : "They’ll lose access to this workspace.",
      confirmLabel: isSelf ? "Leave" : "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await removeMember(projectId, m.user_id);
      if (isSelf) onLeft();
      else await onChange();
    } catch {
      toast("Couldn’t remove.", "error");
    }
  }

  async function revoke(inv: PendingInvite) {
    try {
      await revokeInvitation(projectId, inv.id);
      await onChange();
    } catch {
      toast("Couldn’t revoke.", "error");
    }
  }

  return (
    <div className="space-y-0.5">
      {data.members.map((m) => (
        <MemberRow
          key={m.user_id}
          m={m}
          isMe={m.user_id === meId}
          isOwner={isOwner}
          ownerCount={ownerCount}
          onChangeRole={changeRole}
          onRemove={remove}
        />
      ))}

      {data.invitations.length > 0 && (
        <>
          <div className="px-1 pb-0.5 pt-3 text-xs font-medium text-muted-foreground">
            Invited
          </div>
          {data.invitations.map((inv) => (
            <div
              key={inv.id}
              className="flex items-center gap-3 rounded-md px-1 py-1.5"
            >
              <Avatar name={inv.invited_upn} muted />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{inv.invited_upn}</div>
                <div className="text-xs text-muted-foreground">
                  Pending · appears at their next sign-in
                </div>
              </div>
              <span className="shrink-0 text-xs capitalize text-muted-foreground">
                {inv.role}
              </span>
              {isOwner ? (
                <button
                  type="button"
                  onClick={() => void revoke(inv)}
                  aria-label="Revoke invitation"
                  title="Revoke"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X size={15} />
                </button>
              ) : (
                <span className="w-7 shrink-0" />
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function MemberRow({
  m,
  isMe,
  isOwner,
  ownerCount,
  onChangeRole,
  onRemove,
}: {
  m: Member;
  isMe: boolean;
  isOwner: boolean;
  ownerCount: number;
  onChangeRole: (m: Member, role: MemberRole) => void;
  onRemove: (m: Member) => void;
}) {
  const name = m.display_name || m.upn;
  // The final owner can't be demoted or removed — it would orphan the workspace.
  const isLastOwner = m.role === "owner" && ownerCount <= 1;
  const canManage = isOwner && !isMe && !isLastOwner; // owners manage everyone else
  const canLeave = isMe && !isLastOwner; // you can leave unless you're the last owner

  const roleItems = (["owner", "editor", "viewer"] as MemberRole[]).map((r) => ({
    label: r[0].toUpperCase() + r.slice(1),
    active: m.role === r,
    onClick: () => onChangeRole(m, r),
  }));

  return (
    <div className="flex items-center gap-3 rounded-md px-1 py-1.5">
      <Avatar name={name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          {name}
          {isMe && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{m.upn}</div>
      </div>
      <span className="shrink-0 text-xs capitalize text-muted-foreground">
        {m.role}
      </span>
      {isMe ? (
        canLeave ? (
          <NoteMenu
            label="Your membership"
            align="right"
            items={[
              {
                label: "Leave workspace",
                icon: <LogOut size={15} />,
                onClick: () => onRemove(m),
              },
            ]}
          />
        ) : (
          <span className="w-7 shrink-0" />
        )
      ) : canManage ? (
        <NoteMenu
          label={`Manage ${name}`}
          align="right"
          items={[
            ...roleItems,
            { divider: true },
            { label: "Remove", icon: <X size={15} />, onClick: () => onRemove(m) },
          ]}
        />
      ) : (
        <span className="w-7 shrink-0" />
      )}
    </div>
  );
}

function Avatar({ name, muted }: { name: string; muted?: boolean }) {
  const initial = (name.trim()[0] || "?").toUpperCase();
  return (
    <span
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium",
        muted ? "bg-muted text-muted-foreground" : "bg-accent text-foreground",
      )}
    >
      {initial}
    </span>
  );
}

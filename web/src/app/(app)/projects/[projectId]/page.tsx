"use client";

import { FilePlus, Folder, Globe, Link as LinkIcon, Lock, UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";

import { useShare } from "@/components/share/share-dialog";
import { GuideAndHealth } from "@/components/workspace/guide-and-health";
import { Button } from "@/components/ui/button";
import {
  createNote,
  getMe,
  HttpError,
  listOrgProjects,
  listTree,
  type OrgAccess,
  type Tree,
} from "@/lib/api";
import { useRevalidate } from "@/lib/revalidate";
import { useCopyLink } from "@/lib/use-copy-link";
import { groupNotesByFolder } from "@/lib/workspace";

// What the header shows about the workspace. Members come from /api/me; an
// org-visible workspace the caller isn't a member of comes from the org list
// (always an effective viewer).
type Info = {
  name: string;
  role: string;
  memberCount: number;
  orgAccess: OrgAccess;
  isPersonal: boolean;
  isMember: boolean;
};

type State =
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "error" }
  | { kind: "ready"; info: Info; tree: Tree };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canWrite = (role: string) => role === "owner" || role === "editor";

// Load the tree first: it's the access check (the backend 404s for anyone who
// is neither a member nor, for an org-visible workspace, in the org), so a
// denied caller never gets as far as learning the workspace's name.
async function loadWorkspace(projectId: string): Promise<State> {
  if (!UUID_RE.test(projectId)) return { kind: "denied" };
  let tree: Tree;
  try {
    tree = await listTree(projectId);
  } catch (e) {
    const denied = e instanceof HttpError && [400, 403, 404].includes(e.status);
    return { kind: denied ? "denied" : "error" };
  }
  const me = await getMe();
  const p = me.projects.find((x) => x.id === projectId);
  if (p)
    return {
      kind: "ready",
      tree,
      info: {
        name: p.name,
        role: p.role,
        memberCount: p.member_count ?? 1,
        orgAccess: p.org_access ?? "none",
        isPersonal: p.is_personal,
        isMember: true,
      },
    };
  const o = (await listOrgProjects()).projects.find((x) => x.id === projectId);
  if (!o) return { kind: "error" };
  return {
    kind: "ready",
    tree,
    info: {
      name: o.name,
      role: "viewer",
      memberCount: o.member_count,
      orgAccess: "viewer",
      isPersonal: false,
      isMember: false,
    },
  };
}

// A workspace's landing page (/projects/<id>): what a copied workspace link
// opens. Name, your role, members, visibility, and its notes grouped by
// folder. The sidebar expands + highlights the workspace while it's open.
export default function WorkspacePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const router = useRouter();
  const { openShare } = useShare();
  const copyLink = useCopyLink();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState(false);

  // `quiet` refreshes an already-loaded page in place (revalidate): a transient
  // failure keeps what's on screen rather than flipping to an error.
  const load = useCallback(
    (quiet = false) => {
      loadWorkspace(projectId)
        .catch((): State => ({ kind: "error" }))
        .then((next) =>
          setState((cur) => (quiet && cur.kind === "ready" && next.kind === "error" ? cur : next)),
        );
    },
    [projectId],
  );

  useEffect(() => {
    setState({ kind: "loading" });
    load();
  }, [load]);

  useRevalidate(() => {
    if (state.kind === "ready" && !creating) load(true);
  });

  async function onNew() {
    setCreating(true);
    setCreateErr(false);
    try {
      const n = await createNote(projectId, "Untitled", "");
      router.push(`/notes/${n.id}`);
    } catch {
      setCreateErr(true);
      setCreating(false);
    }
  }

  if (state.kind === "loading")
    return <div className="p-4 text-sm text-muted-foreground md:p-8">loading…</div>;

  if (state.kind === "denied")
    return (
      <div className="p-4 md:p-8">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-muted-foreground">
            <Lock size={18} />
          </span>
          <h1 className="text-base font-semibold">
            You don’t have access to this workspace.
          </h1>
          <p className="text-sm text-muted-foreground">
            Ask its owner to share it with you.
          </p>
        </div>
      </div>
    );

  if (state.kind === "error")
    return (
      <div className="p-4 text-sm text-destructive md:p-8">
        Couldn’t load this workspace.
      </div>
    );

  const { info, tree } = state;
  const groups = groupNotesByFolder(tree);
  const shareTarget = { id: projectId, name: info.name, org_access: info.orgAccess };

  return (
    <div className="p-4 md:p-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{info.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="capitalize">
                {info.role}
                {!info.isMember && " · via organisation"}
              </span>
              {info.isPersonal ? (
                <span>Personal</span>
              ) : (
                <span className="flex items-center gap-1">
                  <Users size={13} />
                  {info.memberCount} {info.memberCount === 1 ? "member" : "members"}
                </span>
              )}
              {info.orgAccess === "viewer" && (
                <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                  <Globe size={12} />
                  Visible to your organisation
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyLink("project", projectId)}
            >
              <LinkIcon size={14} />
              Copy link
            </Button>
            {!info.isPersonal && (
              <Button variant="outline" size="sm" onClick={() => openShare(shareTarget)}>
                {info.role === "owner" ? <UserPlus size={14} /> : <Users size={14} />}
                {info.role === "owner" ? "Share" : "Members"}
              </Button>
            )}
            {canWrite(info.role) && (
              <Button size="sm" onClick={onNew} disabled={creating}>
                <FilePlus size={14} />
                {creating ? "Creating…" : "New note"}
              </Button>
            )}
          </div>
        </div>

        {createErr && (
          <div className="mb-3 text-sm text-destructive">Couldn’t create a note.</div>
        )}

        <GuideAndHealth projectId={projectId} />

        {groups.length === 0 ? (
          <div className="text-sm text-muted-foreground">No notes yet.</div>
        ) : (
          <div className="space-y-5">
            {groups.map((g) => (
              <section key={g.folderId ?? "root"}>
                {g.path.length > 0 && (
                  <h2 className="mb-1.5 flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Folder size={13} className="shrink-0" />
                    <span className="truncate">{g.path.join(" / ")}</span>
                  </h2>
                )}
                <ul className="divide-y rounded-lg border">
                  {g.notes.map((n) => (
                    <li key={n.id}>
                      <Link
                        href={`/notes/${n.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent"
                      >
                        <span className="min-w-0 truncate">{n.title || "Untitled"}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          {n.type && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              {n.type}
                            </span>
                          )}
                          {n.tags.map((t) => (
                            <span
                              key={t}
                              className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                            >
                              #{t}
                            </span>
                          ))}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

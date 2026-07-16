"use client";

import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderTree,
  Monitor,
  Moon,
  Palette,
  Plug,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Dialog } from "@/components/ui/dialog";
import { usePreferences } from "@/lib/use-preferences";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";

// Owns the Settings dialog's open state and the global ⌘,/Ctrl+, shortcut, and
// renders the dialog. Mounted once in (app)/layout.tsx. The account menu's
// "Settings" item calls openSettings(). Mirrors SearchProvider.
type SettingsCtx = { openSettings: () => void };
const Ctx = createContext<SettingsCtx | null>(null);

export function useSettings() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo(() => ({ openSettings: () => setOpen(true) }), []);

  return (
    <Ctx.Provider value={value}>
      {children}
      <SettingsDialog open={open} onClose={() => setOpen(false)} />
    </Ctx.Provider>
  );
}

type SectionId = "appearance" | "preferences" | "workspaces" | "mcp";

const SECTIONS: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
  { id: "preferences", label: "Preferences", icon: <SlidersHorizontal size={16} /> },
  { id: "workspaces", label: "Workspaces", icon: <FolderTree size={16} /> },
  { id: "mcp", label: "MCP", icon: <Plug size={16} /> },
];

function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [active, setActive] = useState<SectionId>("appearance");
  // Below md this is a master–detail drill-down (iOS-style): a list of sections,
  // then one section behind a Back header. `detail` is consulted only on mobile;
  // the desktop two-pane layout renders the rail + content regardless.
  const [detail, setDetail] = useState(false);

  // Each time the dialog opens, mobile starts back at the list.
  useEffect(() => {
    if (open) setDetail(false);
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} className="max-w-3xl overflow-hidden p-0">
      <div className="flex h-[75vh] max-h-[34rem] flex-col md:h-[26rem] md:max-h-none md:flex-row">
        {/* Desktop: persistent left rail (Obsidian-style). Hidden on mobile. */}
        <nav className="hidden w-44 shrink-0 space-y-0.5 border-r bg-sidebar p-2 md:block">
          <div className="px-2 pb-1 pt-1.5 text-sm font-semibold">Settings</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActive(s.id)}
              aria-current={active === s.id}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                active === s.id
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              )}
            >
              <span className="text-muted-foreground">{s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>

        {/* Mobile: the section list. Shown until you drill into a section. */}
        {!detail && (
          <div className="thin-scrollbar flex flex-1 flex-col overflow-y-auto md:hidden">
            <div className="px-4 pb-2 pt-5 text-lg font-semibold tracking-tight">
              Settings
            </div>
            <nav className="px-2 pb-2">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setActive(s.id);
                    setDetail(true);
                  }}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-3 text-left text-sm hover:bg-sidebar-accent"
                >
                  <span className="text-muted-foreground">{s.icon}</span>
                  <span className="flex-1">{s.label}</span>
                  <ChevronRight size={16} className="text-muted-foreground" />
                </button>
              ))}
            </nav>
          </div>
        )}

        {/* Content pane — desktop always; mobile only after drilling in, with a
            Back header. */}
        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden md:flex",
            detail ? "flex" : "hidden",
          )}
        >
          <div className="flex h-11 shrink-0 items-center border-b px-2 md:hidden">
            <button
              type="button"
              onClick={() => setDetail(false)}
              aria-label="Back to settings"
              className="flex h-8 items-center gap-0.5 rounded-md pl-1 pr-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            >
              <ChevronLeft size={18} />
              Settings
            </button>
          </div>
          <div className="thin-scrollbar min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
            {active === "appearance" && <AppearanceSection />}
            {active === "preferences" && <PreferencesSection />}
            {active === "workspaces" && <WorkspacesSection />}
            {active === "mcp" && <McpSection />}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ── Sections ────────────────────────────────────────────────

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { prefs, setPref } = usePreferences();
  return (
    <Section title="Appearance">
      <Row label="Theme" hint="System follows your operating system.">
        <Segmented
          value={theme}
          onChange={setTheme}
          options={[
            { value: "system", label: "System", icon: <Monitor size={15} /> },
            { value: "light", label: "Light", icon: <Sun size={15} /> },
            { value: "dark", label: "Dark", icon: <Moon size={15} /> },
          ]}
        />
      </Row>
      <Row
        label="Code highlighting"
        hint="Colour code blocks by syntax when reading. Language is auto-detected; tagging a fence (```lang) stays optional."
      >
        <BoolSegmented
          value={prefs.codeHighlight}
          onChange={(v) => setPref("codeHighlight", v)}
        />
      </Row>
    </Section>
  );
}

function PreferencesSection() {
  const { prefs, setPref } = usePreferences();
  return (
    <Section
      title="Preferences"
      hint="What a note shows when you open it. Individual notes still remember changes you make to them."
    >
      <Row label="Properties" hint="Auto shows them only when a note has any.">
        <Segmented
          value={prefs.properties}
          onChange={(v) => setPref("properties", v)}
          options={[
            { value: "auto", label: "Auto" },
            { value: "always", label: "Always" },
            { value: "never", label: "Never" },
          ]}
        />
      </Row>
      <Row label="Backlinks" hint="Other notes that link to this one, listed below it.">
        <BoolSegmented
          value={prefs.backlinks}
          onChange={(v) => setPref("backlinks", v)}
        />
      </Row>
      <Row
        label="Related notes"
        hint="Similar notes from the same workspace, suggested below backlinks."
      >
        <BoolSegmented
          value={prefs.related}
          onChange={(v) => setPref("related", v)}
        />
      </Row>
      <Row label="Metadata" hint="The created / last-edited detail in the note header.">
        <BoolSegmented
          value={prefs.metadata}
          onChange={(v) => setPref("metadata", v)}
        />
      </Row>
    </Section>
  );
}

function WorkspacesSection() {
  const { prefs, setPref } = usePreferences();
  return (
    <Section
      title="Workspaces"
      hint="How workspaces shared with everyone in your organisation appear in your sidebar."
    >
      <Row
        label="Organisation workspaces"
        hint="Pinned only keeps just the ones you pin; Show all lists them all."
      >
        <Segmented
          value={prefs.orgWorkspaces}
          onChange={(v) => setPref("orgWorkspaces", v)}
          options={[
            { value: "pinned", label: "Pinned only" },
            { value: "all", label: "Show all" },
          ]}
        />
      </Row>
    </Section>
  );
}

function McpSection() {
  const [info, setInfo] = useState<{ url: string; authMode: string } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    fetch("/api/mcp/info", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => alive && setInfo(d))
      .catch(() => alive && setInfo({ url: "", authMode: "dev" }));
    return () => {
      alive = false;
    };
  }, []);

  const url = info?.url ?? "";
  const config = JSON.stringify(
    { mcpServers: { recall: { type: "http", url: url || "…" } } },
    null,
    2,
  );

  return (
    <Section
      title="MCP"
      hint="Connect an AI client to re:call over the Model Context Protocol, so your notes become grounded context it can search, read and write — always scoped to exactly what you can access."
    >
      <div className="space-y-5 pt-4">
        <div>
          <div className="text-sm font-medium">Endpoint</div>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-2.5 py-1.5 font-mono text-xs">
              {url || "loading…"}
            </code>
            <CopyButton value={url} label="Copy endpoint" />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Client configuration</div>
            <CopyButton value={config} label="Copy config" />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Add to your MCP client (e.g. Claude Code&rsquo;s <code>.mcp.json</code>,
            or a Claude Desktop / Copilot custom connector).
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
            {config}
          </pre>
        </div>

        <div>
          <div className="text-sm font-medium">How it connects</div>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Add the configuration above to your client.</li>
            <li>
              On first use it opens your browser to your organisation&rsquo;s
              sign-in — approve access to connect.
            </li>
            <li>
              re:call&rsquo;s tools appear in the client, acting on your notes
              with your own permissions.
            </li>
          </ol>
        </div>

        {info?.authMode !== "entra" && (
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            This instance runs in developer mode: the endpoint is unauthenticated
            and every call acts as the local dev user. Sign-in is enforced when
            deployed with Entra.
          </p>
        )}
      </div>
    </Section>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      disabled={!value}
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
        "text-muted-foreground hover:text-foreground disabled:opacity-50",
      )}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ── Building blocks ─────────────────────────────────────────

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h2 className="text-base font-semibold">{title}</h2>
      {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
      <div className="mt-4 divide-y">{children}</div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 py-3 md:flex-row md:items-center md:justify-between md:gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// A single-source segmented control used for every setting, so the whole dialog
// reads as one system (theme, properties tri-state, and the on/off toggles).
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-sm transition-colors",
            value === o.value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function BoolSegmented({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Segmented<"off" | "on">
      value={value ? "on" : "off"}
      onChange={(v) => onChange(v === "on")}
      options={[
        { value: "off", label: "Off" },
        { value: "on", label: "On" },
      ]}
    />
  );
}

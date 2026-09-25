"use client";

import {
  Braces,
  Calendar,
  CalendarClock,
  Hash,
  List,
  Plus,
  SquareCheck,
  Tags,
  Type,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { listMembers, type GuideConventions, type Member, type Note } from "@/lib/api";
import type { FrontmatterValue } from "@/lib/frontmatter";
import { ownerStatus, reviewConfirmation } from "@/lib/health";
import { cn } from "@/lib/utils";

// Obsidian-style Properties editor. Properties are the note's YAML frontmatter;
// each row has an editable key and a type-aware value editor. The backend
// already parsed the YAML, so values arrive typed (via note.type/status/tags +
// note.metadata) and we infer each property's kind from its value. Edits write
// back through `onChange` (one key at a time) → the note body → autosave.
// When the workspace has a guide, its declared types, statuses and tags are
// offered as suggestions (never enforced).

// "object" = a nested YAML value (a mapping, or a list of mappings) such as a
// guide's `types:` block. Shown read-only: this editor writes flat
// `key: value` lines, so editing it here would flatten it. Raw text edits it.
type Kind = "text" | "list" | "tags" | "number" | "checkbox" | "date" | "datetime" | "object";
type PropValue = string | string[] | number | boolean | Record<string, unknown> | unknown[];
type Prop = { id: string; key: string; value: PropValue; kind: Kind };

const TYPE_OPTIONS: { kind: Kind; label: string }[] = [
  { kind: "text", label: "Text" },
  { kind: "list", label: "List" },
  { kind: "number", label: "Number" },
  { kind: "checkbox", label: "Checkbox" },
  { kind: "date", label: "Date" },
  { kind: "datetime", label: "Date & time" },
  { kind: "tags", label: "Tags" },
];

// Names offered as quick-adds in the "Add property" menu. `owner` and
// `review_every` feed the workspace page's Health section.
const SUGGESTED: { key: string; kind: Kind }[] = [
  { key: "type", kind: "text" },
  { key: "status", kind: "text" },
  { key: "tags", kind: "tags" },
  { key: "owner", kind: "text" },
  { key: "review_every", kind: "text" },
];

// A value suggestion; `label` explains it in the dropdown.
type Option = { value: string; label?: string };

// Periods offered for `review_every`, one per unit so the list also shows the
// format. The backend reads other forms too ("6 months", "quarterly", "6M")
// and never rewrites what was typed.
const REVIEW_PERIODS: Option[] = [
  { value: "2w", label: "every 2 weeks" },
  { value: "30d", label: "every 30 days" },
  { value: "1mo", label: "every month" },
  { value: "3mo", label: "every 3 months" },
  { value: "6mo", label: "every 6 months" },
  { value: "1y", label: "every year" },
];

let _uid = 0;
const nextId = () => `p${++_uid}`;

function isNested(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => x !== null && typeof x === "object");
  return v !== null && typeof v === "object";
}

function inferKind(key: string, v: unknown): Kind {
  if (isNested(v)) return "object";
  if (key === "tags") return "tags";
  if (Array.isArray(v)) return "list";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "checkbox";
  return "text";
}

function initProps(note: Note): Prop[] {
  const out: Prop[] = [];
  if (note.type) out.push({ id: nextId(), key: "type", value: note.type, kind: "text" });
  if (note.status) out.push({ id: nextId(), key: "status", value: note.status, kind: "text" });
  if (note.tags.length) out.push({ id: nextId(), key: "tags", value: note.tags, kind: "tags" });
  for (const [k, v] of Object.entries(note.metadata ?? {})) {
    out.push({ id: nextId(), key: k, value: (v ?? "") as PropValue, kind: inferKind(k, v) });
  }
  return out;
}

// Reinterpret a value when its property type changes.
function convert(value: PropValue, to: Kind): PropValue {
  const asStr = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  switch (to) {
    case "list":
    case "tags":
      return Array.isArray(value)
        ? value
        : asStr.split(",").map((s) => s.trim()).filter(Boolean);
    case "number": {
      const n = Number(Array.isArray(value) ? value[0] : value);
      return Number.isFinite(n) ? n : 0;
    }
    case "checkbox":
      return value === true || asStr === "true";
    default:
      return asStr;
  }
}

function emptyFor(kind: Kind): PropValue {
  if (kind === "tags" || kind === "list") return [];
  if (kind === "number") return 0;
  if (kind === "checkbox") return false;
  return "";
}

// Value suggestions for a property: the guide's types and tags, common review
// periods, and workspace members for `owner`. Suggestions only; any value can
// be typed.
function optionsFor(prop: Prop, conv: GuideConventions | null, members: Member[]): Option[] {
  if (prop.key === "review_every") return REVIEW_PERIODS;
  // Only the email is written; the name is the dropdown label.
  if (prop.key === "owner")
    return members.map((m) => ({ value: m.upn, label: m.display_name ?? undefined }));
  if (!conv) return [];
  if (prop.key === "type") return conv.types.map((value) => ({ value }));
  if (prop.kind === "tags") return conv.tags.map((value) => ({ value }));
  return [];
}

export function NoteProperties({
  note,
  onChange,
  readOnly = false,
  conventions = null,
}: {
  note: Note;
  onChange: (updates: Record<string, FrontmatterValue>) => void;
  readOnly?: boolean;
  conventions?: GuideConventions | null;
}) {
  // Local, authoritative list (the parent keys this by note.id, so it
  // re-initialises per note and survives autosave refreshes of the same note).
  const [props, setProps] = useState<Prop[]>(() => initProps(note));

  // Members, for `owner` suggestions and the "· member" check. Fetched only
  // once the note has an owner property.
  const hasOwner = !readOnly && props.some((p) => p.key === "owner");
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    if (!hasOwner) return;
    let cancelled = false;
    listMembers(note.project_id)
      .then((r) => !cancelled && setMembers(r.members))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasOwner, note.project_id]);

  // The muted line under a value: how `review_every` was read (server-side,
  // refreshed on save) or who `owner` is (live, from the member list).
  const lineFor = (p: Prop): { text: string; warn: boolean } | null => {
    if (p.key === "review_every") {
      const text = reviewConfirmation(note.review);
      return text ? { text, warn: false } : null;
    }
    if (p.key === "owner" && typeof p.value === "string" && members.length > 0)
      return ownerStatus(p.value, members);
    return null;
  };

  const setValue = (i: number, value: PropValue) => {
    setProps((prev) => prev.map((p, j) => (j === i ? { ...p, value } : p)));
    if (props[i].key) onChange({ [props[i].key]: value as FrontmatterValue });
  };

  const setKind = (i: number, kind: Kind) => {
    const value = convert(props[i].value, kind);
    setProps((prev) => prev.map((p, j) => (j === i ? { ...p, kind, value } : p)));
    if (props[i].key) onChange({ [props[i].key]: value as FrontmatterValue });
  };

  const remove = (i: number) => {
    const { key } = props[i];
    setProps((prev) => prev.filter((_, j) => j !== i));
    if (key) onChange({ [key]: null });
  };

  // Rename a property's key. Returns false (rejected) on a duplicate.
  const rename = (i: number, raw: string): boolean => {
    const newKey = raw.trim();
    const cur = props[i];
    if (newKey === cur.key) return true;
    if (newKey && props.some((p, j) => j !== i && p.key === newKey)) return false;
    setProps((prev) => prev.map((p, j) => (j === i ? { ...p, key: newKey } : p)));
    const updates: Record<string, FrontmatterValue> = {};
    if (cur.key) updates[cur.key] = null;
    if (newKey) updates[newKey] = cur.value as FrontmatterValue;
    if (Object.keys(updates).length) onChange(updates);
    return true;
  };

  const add = (key: string, kind: Kind) => {
    if (key && props.some((p) => p.key === key)) return;
    const value = emptyFor(kind);
    setProps((prev) => [...prev, { id: nextId(), key, value, kind }]);
    if (key && (kind === "checkbox" || kind === "number")) {
      onChange({ [key]: value as FrontmatterValue });
    }
  };

  // Viewers get a static list — same layout, no inputs / add / context menu.
  if (readOnly) {
    if (props.length === 0)
      return <div className="text-sm text-muted-foreground">No properties.</div>;
    return (
      <div className="space-y-1 text-sm">
        {props.map((p) => (
          <div key={p.id} className="flex items-baseline gap-3">
            <div className="flex w-28 shrink-0 items-center gap-1.5 pt-0.5 text-muted-foreground md:w-40">
              <KindIcon kind={p.kind} />
              <span className="truncate" title={p.key}>
                {p.key}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <ReadOnlyValue prop={p} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1 text-sm">
      {props.map((p, i) => (
        <PropertyRow
          key={p.id}
          prop={p}
          onKey={(k) => rename(i, k)}
          onValue={(v) => setValue(i, v)}
          onKind={(k) => setKind(i, k)}
          onRemove={() => remove(i)}
          options={optionsFor(p, conventions, members)}
          line={lineFor(p)}
        />
      ))}
      <AddProperty existing={props.map((p) => p.key)} onAdd={add} />
    </div>
  );
}

// Static value display for the read-only (viewer) Properties list.
function ReadOnlyValue({ prop }: { prop: Prop }) {
  if (prop.kind === "object") return <NestedValue value={prop.value} />;
  if (prop.kind === "tags" || prop.kind === "list") {
    const items = Array.isArray(prop.value) ? (prop.value as string[]) : [];
    if (items.length === 0) return <span className="text-muted-foreground">Empty</span>;
    return (
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <span key={item} className="rounded bg-accent px-1.5 py-0.5 text-xs">
            {item}
          </span>
        ))}
      </div>
    );
  }
  if (prop.kind === "checkbox") return <span>{prop.value === true ? "Yes" : "No"}</span>;
  const text = prop.value == null || prop.value === "" ? "" : String(prop.value);
  return text ? <span>{text}</span> : <span className="text-muted-foreground">Empty</span>;
}

// A nested value summarised: a mapping's keys, or a list's length.
function NestedValue({ value }: { value: PropValue }) {
  const text = Array.isArray(value)
    ? `${value.length} ${value.length === 1 ? "item" : "items"}`
    : Object.keys(value as Record<string, unknown>).join(", ") || "Empty";
  return (
    <span className="text-muted-foreground" title="Nested value: edit it in Raw text">
      {text}
    </span>
  );
}

function PropertyRow({
  prop,
  onKey,
  onValue,
  onKind,
  onRemove,
  options,
  line,
}: {
  prop: Prop;
  onKey: (k: string) => boolean;
  onValue: (v: PropValue) => void;
  onKind: (k: Kind) => void;
  onRemove: () => void;
  options: Option[];
  // A muted line under the value (e.g. how review_every was understood).
  line?: { text: string; warn: boolean } | null;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [keyDraft, setKeyDraft] = useState(prop.key);

  return (
    <div
      className="flex items-baseline gap-3"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* Wider on desktop so keys like workspace_types fit; the title shows
          the full key wherever it's still cut off (phones). */}
      <div className="flex w-28 shrink-0 items-center gap-1.5 pt-0.5 text-muted-foreground md:w-40">
        <KindIcon kind={prop.kind} />
        <input
          value={keyDraft}
          title={keyDraft}
          readOnly={prop.kind === "object"}
          autoFocus={prop.key === ""}
          placeholder="key"
          onChange={(e) => setKeyDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          onBlur={() => {
            if (!onKey(keyDraft)) setKeyDraft(prop.key); // reject duplicate
          }}
          className="min-w-0 flex-1 rounded bg-transparent outline-none hover:bg-accent/40 focus:bg-accent/50"
        />
      </div>
      <div className="min-w-0 flex-1">
        <ValueEditor
          key={prop.kind}
          prop={prop}
          onValue={onValue}
          options={options}
        />
        {line && (
          <div
            className={cn(
              "px-1.5 text-xs",
              line.warn ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
            )}
          >
            {line.text}
          </div>
        )}
      </div>
      {menu && (
        <PropContextMenu
          x={menu.x}
          y={menu.y}
          current={prop.kind}
          onKind={(k) => {
            onKind(k);
            setMenu(null);
          }}
          onRemove={() => {
            onRemove();
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function ValueEditor({
  prop,
  onValue,
  options,
}: {
  prop: Prop;
  onValue: (v: PropValue) => void;
  options: Option[];
}) {
  const listId = useId();
  if (prop.kind === "object") return <NestedValue value={prop.value} />;
  if (prop.kind === "tags" || prop.kind === "list") {
    return (
      <ListEditor
        value={Array.isArray(prop.value) ? (prop.value as string[]) : []}
        isTags={prop.kind === "tags"}
        onValue={onValue}
        options={options}
      />
    );
  }
  if (prop.kind === "checkbox") {
    return (
      <input
        type="checkbox"
        checked={prop.value === true}
        onChange={(e) => onValue(e.target.checked)}
        className="h-4 w-4 align-middle"
      />
    );
  }
  if (prop.kind === "date" || prop.kind === "datetime") {
    return <DateEditor prop={prop} onValue={onValue} />;
  }
  const type = prop.kind === "number" ? "number" : "text";
  const suggestable = type === "text" && options.length > 0;
  return (
    <>
      {suggestable && (
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o.value} value={o.value} label={o.label} />
          ))}
        </datalist>
      )}
      <input
        type={type}
        list={suggestable ? listId : undefined}
        defaultValue={prop.value == null ? "" : String(prop.value)}
        placeholder="Empty"
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={(e) =>
          onValue(
            prop.kind === "number"
              ? e.target.value === ""
                ? 0
                : Number(e.target.value)
              : e.target.value,
          )
        }
        className="w-full rounded bg-transparent px-1.5 py-0.5 outline-none hover:bg-accent/40 focus:bg-accent/50"
      />
    </>
  );
}

function DateEditor({
  prop,
  onValue,
}: {
  prop: Prop;
  onValue: (v: PropValue) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const type = prop.kind === "datetime" ? "datetime-local" : "date";
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label="Open date picker"
        onClick={() => ref.current?.showPicker?.()}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <KindIcon kind="date" />
      </button>
      <input
        ref={ref}
        type={type}
        defaultValue={prop.value == null ? "" : String(prop.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={(e) => onValue(e.target.value)}
        className="date-field rounded bg-transparent px-1.5 py-0.5 outline-none hover:bg-accent/40 focus:bg-accent/50"
      />
    </div>
  );
}

// Obsidian tags can't contain spaces or punctuation — only letters/digits and
// `_ - /` (for nesting). Normalise on entry; plain lists allow any string.
function normalizeTag(s: string): string {
  return s.trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_/-]/gu, "");
}

function ListEditor({
  value,
  isTags,
  onValue,
  options,
}: {
  value: string[];
  isTags: boolean;
  onValue: (v: string[]) => void;
  options: Option[];
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const remaining = options.map((o) => o.value).filter((o) => !value.includes(o));
  const commit = (s: string) => {
    const t = isTags ? normalizeTag(s) : s.trim();
    if (t && !value.includes(t)) onValue([...value, t]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((item) => (
        <span
          key={item}
          className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-xs"
        >
          {item}
          <button
            type="button"
            aria-label={`Remove ${item}`}
            onClick={() => onValue(value.filter((x) => x !== item))}
            className="text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
      {remaining.length > 0 && (
        <datalist id={listId}>
          {remaining.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
      <input
        value={draft}
        list={remaining.length > 0 ? listId : undefined}
        onChange={(e) => {
          // Picking a suggestion replaces the text in one go: add it at once.
          const picked =
            (e.nativeEvent as InputEvent).inputType === "insertReplacementText" ||
            (e.nativeEvent as InputEvent).inputType === undefined;
          if (picked && remaining.includes(e.target.value)) commit(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && value.length) {
            onValue(value.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        placeholder={value.length ? "" : "Empty"}
        className="min-w-16 flex-1 bg-transparent px-1 py-0.5 outline-none"
      />
    </div>
  );
}

function AddProperty({
  existing,
  onAdd,
}: {
  existing: string[];
  onAdd: (key: string, kind: Kind) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const suggestions = SUGGESTED.filter((s) => !existing.includes(s.key));
  const choose = (key: string, kind: Kind) => {
    onAdd(key, kind);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative pt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
      >
        <Plus size={14} />
        Add property
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md border bg-background p-1 shadow-md">
          {suggestions.length > 0 && (
            <>
              <MenuLabel>Suggested</MenuLabel>
              {suggestions.map((s) => (
                <MenuItem key={s.key} kind={s.kind} label={s.key} onClick={() => choose(s.key, s.kind)} />
              ))}
            </>
          )}
          <MenuLabel>New property</MenuLabel>
          {TYPE_OPTIONS.map((o) => (
            <MenuItem key={o.kind} kind={o.kind} label={o.label} onClick={() => choose("", o.kind)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-0.5 pt-1.5 text-xs uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function MenuItem({
  kind,
  label,
  onClick,
}: {
  kind: Kind;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
    >
      <KindIcon kind={kind} />
      {label}
    </button>
  );
}

function PropContextMenu({
  x,
  y,
  current,
  onKind,
  onRemove,
  onClose,
}: {
  x: number;
  y: number;
  current: Kind;
  onKind: (k: Kind) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ left: x, top: y }}
      className="fixed z-30 min-w-40 rounded-md border bg-background p-1 shadow-md"
    >
      <div className="px-2 py-1 text-xs uppercase tracking-wide text-muted-foreground">
        Property type
      </div>
      {current !== "object" && TYPE_OPTIONS.map((o) => (
        <button
          key={o.kind}
          type="button"
          onClick={() => onKind(o.kind)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
        >
          <span className="w-3 text-muted-foreground">{o.kind === current ? "✓" : ""}</span>
          <KindIcon kind={o.kind} />
          {o.label}
        </button>
      ))}
      <div className="my-1 border-t" />
      <button
        type="button"
        onClick={onRemove}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent"
      >
        <span className="w-3" />
        Remove
      </button>
    </div>
  );
}

const KIND_ICON: Record<Kind, typeof Type> = {
  text: Type,
  list: List,
  tags: Tags,
  number: Hash,
  checkbox: SquareCheck,
  date: Calendar,
  datetime: CalendarClock,
  object: Braces,
};

function KindIcon({ kind }: { kind: Kind }) {
  const Icon = KIND_ICON[kind];
  return <Icon size={14} className="shrink-0" />;
}

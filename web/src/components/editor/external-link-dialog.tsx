"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

// Add a bare URL a scheme so "example.com" becomes a real link rather than a
// relative path. Leaves anything that already looks addressed (has a scheme, or
// is a root/anchor path) untouched.
function normalizeUrl(url: string): string {
  const u = url.trim();
  if (!u) return u;
  if (/^([a-z][\w+.-]*:|\/|#|mailto:)/i.test(u)) return u;
  return `https://${u}`;
}

// Small form for inserting an external markdown link: a label and a URL, matching
// the app's dialog style. Any selected text pre-fills the label; the URL is
// typed in (no search). Submitting inserts `[text](url)`; cancelling writes
// nothing.
export function ExternalLinkDialog({
  open,
  initialText,
  onSubmit,
  onClose,
}: {
  open: boolean;
  initialText: string;
  onSubmit: (link: { text: string; url: string }) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const textRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setText(initialText);
    setUrl("");
    // With text already selected the user just needs the URL; otherwise start at
    // the label field.
    const el = initialText ? urlRef.current : textRef.current;
    el?.focus();
    el?.select();
  }, [open, initialText]);

  const submit = () => {
    const finalUrl = normalizeUrl(url);
    if (!finalUrl) return;
    onSubmit({ text: text.trim() || finalUrl, url: finalUrl });
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add external link" className="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="mt-4 space-y-3"
      >
        <label className="block space-y-1">
          <span className="text-sm font-medium">Text</span>
          <input
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Link text"
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">URL</span>
          <input
            ref={urlRef}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            inputMode="url"
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!url.trim()}>
            Insert link
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

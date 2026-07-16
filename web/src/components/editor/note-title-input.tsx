"use client";

import { useLayoutEffect, useRef } from "react";

// The note title. A plain <input> can't wrap, so long titles were clipped
// (sooner on narrow/mobile widths). This is a textarea that auto-grows to fit
// wrapped lines, while staying a single *logical* line: newlines are stripped
// and Enter is swallowed, so the title never contains line breaks.
export function NoteTitleInput({
  value,
  onChange,
  readOnly,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow to fit the wrapped content. Keyed on value so it also resizes on an
  // external change (switching notes, reload/adopt), not just typing.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      readOnly={readOnly}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value.replace(/\n/g, ""))}
      onKeyDown={(e) => {
        // A title is one logical line — Enter shouldn't insert a break.
        if (e.key === "Enter") e.preventDefault();
      }}
      className={className}
    />
  );
}

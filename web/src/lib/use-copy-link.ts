"use client";

import { useCallback } from "react";

import { useToast } from "@/components/ui/toast";
import { copyText, type LinkTarget, linkUrl } from "@/lib/links";

// Copy a workspace / note link to the clipboard and confirm with a toast.
export function useCopyLink() {
  const { toast } = useToast();
  return useCallback(
    async (kind: LinkTarget, id: string) => {
      const ok = await copyText(linkUrl(window.location.origin, kind, id));
      if (ok) toast("Link copied");
      else toast("Couldn’t copy the link.", "error");
    },
    [toast],
  );
}

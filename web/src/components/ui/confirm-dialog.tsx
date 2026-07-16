"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<ConfirmFn | null>(null);

// Promise-based replacement for window.confirm(). Mount once near the app root;
// `useConfirm()` returns a function that opens the dialog and resolves to the
// user's choice, so callers keep their imperative `if (!(await confirm(…)))`
// flow. Only one prompt shows at a time (the latest supersedes any pending).
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    // Resolve any in-flight prompt as cancelled before replacing it.
    resolver.current?.(false);
    setOpts(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpts(null);
  }, []);

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <Dialog
        open={opts !== null}
        onClose={() => settle(false)}
        title={opts?.title}
        description={opts?.description}
        showClose={false}
      >
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            autoFocus={opts?.danger}
            onClick={() => settle(false)}
          >
            {opts?.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={opts?.danger ? "destructive" : "default"}
            size="sm"
            autoFocus={!opts?.danger}
            onClick={() => settle(true)}
          >
            {opts?.confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </Dialog>
    </Ctx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}

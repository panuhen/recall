"use client";

import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useRef, useState } from "react";

import { Dialog } from "@/components/ui/dialog";

import { downloadPng, downloadSvg } from "./mermaid";

// An expanded, zoomable/pannable view of a rendered Mermaid diagram, opened from
// the Reading view's diagram toolbar. Reuses the Dialog primitive (Escape /
// backdrop close, scroll lock, focus) sized near-fullscreen. The diagram is the
// already-sanitized SVG string, so it drops straight in via dangerouslySetInnerHTML.

const MIN = 0.2;
const MAX = 10;
const STEP = 1.25; // multiplicative zoom per button press / wheel notch

const clamp = (n: number) => Math.min(MAX, Math.max(MIN, n));

export function MermaidLightbox({
  svg,
  onClose,
}: {
  svg: string;
  onClose: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  // Translation is measured from the stage centre (the transform-origin), in px.
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const reset = () => {
    setScale(1);
    setTx(0);
    setTy(0);
  };

  // Zoom about a fixed screen point (given relative to the stage centre) so the
  // content under the cursor / centre stays put. See derivation: for target
  // scale s', t' = p·(1 − s'/s) + t·(s'/s).
  function zoomTo(next: number, px = 0, py = 0) {
    setScale((s) => {
      const clamped = clamp(next);
      const r = clamped / s;
      setTx((t) => px * (1 - r) + t * r);
      setTy((t) => py * (1 - r) + t * r);
      return clamped;
    });
  }

  function onWheel(e: React.WheelEvent) {
    // No preventDefault: React registers `wheel` as passive (calling it warns),
    // and there's nothing scrollable here — the Dialog locks body scroll and the
    // stage is overflow:hidden, so the wheel only ever drives zoom.
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;
    zoomTo(scale * (e.deltaY < 0 ? STEP : 1 / STEP), px, py);
  }

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY };
    stageRef.current?.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setTx((t) => t + dx);
    setTy((t) => t + dy);
  }
  function onPointerUp(e: React.PointerEvent) {
    drag.current = null;
    stageRef.current?.releasePointerCapture(e.pointerId);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      showClose={false}
      className="mermaid-lightbox h-[88vh] w-[92vw] max-w-none overflow-hidden p-0"
    >
      <div
        ref={stageRef}
        className="mermaid-lightbox-stage"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
        role="img"
        aria-label="Zoomable diagram — drag to pan, scroll to zoom"
      >
        <div
          className="mermaid-lightbox-content"
          style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      <div className="mermaid-lightbox-bar" role="group" aria-label="Diagram controls">
        <button
          type="button"
          className="mermaid-tool-btn"
          onClick={() => zoomTo(scale / STEP)}
          aria-label="Zoom out"
        >
          <ZoomOut size={16} />
        </button>
        <button
          type="button"
          className="mermaid-tool-btn mermaid-zoom-readout"
          onClick={reset}
          title="Reset zoom"
          aria-label={`Zoom ${Math.round(scale * 100)} percent — reset`}
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          className="mermaid-tool-btn"
          onClick={() => zoomTo(scale * STEP)}
          aria-label="Zoom in"
        >
          <ZoomIn size={16} />
        </button>
        <button
          type="button"
          className="mermaid-tool-btn"
          onClick={reset}
          aria-label="Reset view"
        >
          <RotateCcw size={16} />
        </button>

        <span className="mermaid-bar-sep" aria-hidden="true" />

        <button
          type="button"
          className="mermaid-tool-btn"
          onClick={() => downloadSvg(svg)}
        >
          SVG
        </button>
        <button
          type="button"
          className="mermaid-tool-btn"
          onClick={() => void downloadPng(svg)}
        >
          PNG
        </button>

        <button
          type="button"
          className="mermaid-tool-btn mermaid-bar-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </Dialog>
  );
}

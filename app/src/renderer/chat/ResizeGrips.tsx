import type { ResizeEdge } from "@shared/ipc-contract";
import type { JSX } from "react";

// Edge and corner grips for resizing the frameless popover. Windows drops the
// native resize frame from transparent windows, so resizing is manual: each
// grip reports grip, move ticks, and release over the bridge, and main
// repositions the window from the true cursor (the same pattern as dragging
// the pet). Pointer capture keeps the ticks flowing even when a fast drag
// momentarily leaves the grip's own box.

const EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function ResizeGrips(): JSX.Element {
  return (
    <>
      {EDGES.map((edge) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only resize grips, no keyboard equivalent by design
        <div
          key={edge}
          className={`resize-grip ${edge}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            window.sandiChat.beginResize(edge);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
              return;
            }
            window.sandiChat.resizeMove();
          }}
          onPointerUp={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
              return;
            }
            event.currentTarget.releasePointerCapture(event.pointerId);
            window.sandiChat.endResize();
          }}
          onPointerCancel={() => window.sandiChat.endResize()}
        />
      ))}
    </>
  );
}

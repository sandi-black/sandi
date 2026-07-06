import type { JSX } from "react";

import { useChatStore } from "./store";

// The thin footer: link state at a glance, plus the dismissible strip for the
// most recent failed bridge call (fed by guard.ts). Pairing lives in its own
// PairingCard component; this bar only reports.

const LABELS: Record<string, string> = {
  unpaired: "not paired",
  connecting: "connecting...",
  linked: "linked to Sandi",
  dropped: "link dropped, retrying",
};

export function StatusBar(): JSX.Element {
  const link = useChatStore((state) => state.link);
  const uiError = useChatStore((state) => state.uiError);
  const setUiError = useChatStore((state) => state.setUiError);
  return (
    <>
      {uiError && (
        <div className="ui-error">
          <span>{uiError}</span>
          <button
            type="button"
            title="Dismiss"
            onClick={() => setUiError(undefined)}
          >
            ✕
          </button>
        </div>
      )}
      <div className="status-bar">
        <span className={`status-dot ${link.state}`} />
        <span title={link.message}>{LABELS[link.state] ?? link.state}</span>
      </div>
    </>
  );
}

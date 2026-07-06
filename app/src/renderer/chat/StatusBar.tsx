import { type JSX, useState } from "react";

import { useChatStore } from "./store";

// The thin footer: link state at a glance. Pairing itself renders as a card
// in the main pane (see ChatApp) so the code entry is unmissable on first
// run; this bar just reports.

const LABELS: Record<string, string> = {
  unpaired: "not paired",
  connecting: "connecting...",
  linked: "linked to Sandi",
  dropped: "link dropped, retrying",
};

export function StatusBar(): JSX.Element {
  const link = useChatStore((state) => state.link);
  return (
    <div className="status-bar">
      <span className={`status-dot ${link.state}`} />
      <span title={link.message}>{LABELS[link.state] ?? link.state}</span>
    </div>
  );
}

// First-run pairing card: enter the one-time code from /sandi auth.
export function PairingCard({ onPaired }: { onPaired(): void }): JSX.Element {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const redeem = async (): Promise<void> => {
    if (busy || code.trim().length === 0) return;
    setBusy(true);
    setError(undefined);
    const outcome = await window.sandiChat.pair(code.trim());
    setBusy(false);
    if (outcome.ok) {
      onPaired();
    } else {
      setError(outcome.error);
    }
  };

  return (
    <div className="pairing">
      <h2>Pair this desktop with Sandi</h2>
      <p>
        Ask her for a code with <code>/sandi auth</code> on Discord, then enter
        it here. Pairing lets Sandi use this machine as her hands.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void redeem();
        }}
      >
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="XXXX-XXXX"
          spellCheck={false}
          // The pairing card is the whole window on first run; the code
          // field is the only thing to focus.
          // biome-ignore lint/a11y/noAutofocus: single-field first-run card
          autoFocus
        />
        <button type="submit" disabled={busy}>
          {busy ? "..." : "Pair"}
        </button>
      </form>
      {error && <div className="pairing-error">{error}</div>}
    </div>
  );
}

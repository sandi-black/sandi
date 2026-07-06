import { type JSX, useState } from "react";

// First-run pairing card: enter the one-time code from /sandi auth. Fills the
// main pane while the app is unpaired (see ChatApp) so the code entry is
// unmissable.
export function PairingCard({ onPaired }: { onPaired(): void }): JSX.Element {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const redeem = async (): Promise<void> => {
    if (busy || code.trim().length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await window.sandiChat.pair(code.trim());
      if (outcome.ok) {
        onPaired();
      } else {
        setError(outcome.error);
      }
    } catch (redeemError) {
      // The IPC call itself failed (not a rejected code); show it in the same
      // place so the human is never stuck on a spinner.
      setError(
        redeemError instanceof Error
          ? redeemError.message
          : String(redeemError),
      );
    } finally {
      setBusy(false);
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
          // redeem() handles its own failures (try/catch into the card's
          // error line), so there is nothing left to reject here.
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

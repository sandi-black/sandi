import type { ServerResponse } from "node:http";

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // The page loads nothing external and refuses framing, so another site cannot
  // overlay the pairing-code field.
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

const STYLE = [
  ":root{color-scheme:light dark;--bg:#f7f5f2;--fg:#23201c;--muted:#6b645c;--line:#d9d3ca;--accent:#3f5bd8;--accent-fg:#fff;--notice:#f3e8d2;--error:#b42318}",
  "@media (prefers-color-scheme:dark){:root{--bg:#1b1916;--fg:#ede8e1;--muted:#a39b91;--line:#3a3631;--accent:#8ea2ff;--accent-fg:#10131f;--notice:#352c1b;--error:#ff8a80}}",
  "*{box-sizing:border-box}",
  'body{margin:0;background:var(--bg);color:var(--fg);font:1rem/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding-block:3rem;padding-inline:1rem}',
  "main{max-width:30rem;margin-inline:auto}",
  "h1{font-size:1.5rem;line-height:1.25;margin:0 0 1rem}",
  "p{margin:0 0 1rem}",
  ".notice{background:var(--notice);border-radius:.5rem;padding:.75rem 1rem}",
  "label{display:block;font-weight:600;margin-top:1.5rem}",
  ".hint{color:var(--muted);margin:.25rem 0 .75rem}",
  ".error{color:var(--error);font-weight:600}",
  "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}",
  "input{width:100%;font:1.25rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;padding:.6rem .75rem;border:1px solid var(--line);border-radius:.5rem;background:transparent;color:inherit}",
  "button{margin-top:1rem;width:100%;font:inherit;font-weight:600;padding:.7rem;border:0;border-radius:.5rem;background:var(--accent);color:var(--accent-fg);cursor:pointer}",
].join("");

export type AuthorizePageInput = {
  // The name the agent registered. Nothing verifies it, so the page shows it as
  // a claim and names the destination host separately.
  clientName: string | undefined;
  destinationHost: string;
  local: boolean;
  fields: ReadonlyMap<string, string>;
  error?: string;
};

export function sendAuthorizePage(
  response: ServerResponse,
  status: number,
  input: AuthorizePageInput,
): void {
  const name = escapeHtml(input.clientName ?? "an unnamed agent");
  const host = escapeHtml(input.destinationHost);
  const destination = input.local
    ? `It will send your access to an app on this computer (<strong>${host}</strong>). Continue only if you just started connecting an agent here.`
    : `It will send your access to <strong>${host}</strong>. Continue only if you trust that site.`;
  const hidden = [...input.fields]
    .map(
      ([field, value]) =>
        `<input type="hidden" name="${escapeHtml(field)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  sendPage(
    response,
    status,
    [
      "<h1>Connect an agent to Sandi</h1>",
      `<p>An agent calling itself <strong>${name}</strong> wants to talk to Sandi as you, with your memory and preferences.</p>`,
      `<p class="notice">${destination}</p>`,
      '<form method="post" action="/oauth/authorize">',
      hidden,
      '<label for="code">Pairing code</label>',
      '<p class="hint">Run <code>/sandi auth</code> in Discord, then paste the code it gives you.</p>',
      input.error
        ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>`
        : "",
      '<input id="code" name="code" required autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" autofocus>',
      '<button type="submit">Connect</button>',
      "</form>",
    ].join(""),
  );
}

export function sendAuthorizeError(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  sendPage(
    response,
    status,
    [
      "<h1>Sandi can't connect this agent</h1>",
      `<p>${escapeHtml(message)}</p>`,
      "<p>Start connecting again from the agent.</p>",
    ].join(""),
  );
}

function sendPage(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to Sandi</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>\n`;
  response.writeHead(status, {
    ...PAGE_HEADERS,
    "content-length": Buffer.byteLength(html),
  });
  response.end(html);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

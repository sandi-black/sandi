# Implementation plans

These plans build one capability in dependency order. Each milestone follows the
same loop: implement, verify, review with fresh eyes, address findings, commit,
then continue.

| Plan | Outcome                                                        | Depends on | Status |
| ---- | -------------------------------------------------------------- | ---------- | ------ |
| 001  | Desktop-hosted MCP tools are available to every Sandi turn     | none       | DONE   |
| 002  | Supported MCP runtimes and servers ship inside the Windows app | 001        | DONE   |
| 003  | Sandi uses semantic Windows and browser automation by default  | 001, 002   | DONE   |

## Decisions shared by all plans

- The Electron app owns desktop-affine MCP clients and stdio processes. The
  server forwards bounded operations through the existing identity-scoped
  desktop lease.
- Pi exposes a fixed MCP search, describe, call, and configuration surface.
  Code mode can compose the same operations within one turn.
- Persistent server configuration is managed through the authenticated desktop
  lease. Secret values stay on the desktop.
- Supported runtimes and curated servers are packaged with the Windows app and
  resolve through stable command IDs.
- Native Windows UI uses Windows-MCP, page content uses Chrome DevTools MCP,
  direct system work uses existing local tools, and screenshots cover targets
  without a useful semantic interface.
- AutoIt is deferred until a real, repeated workflow demonstrates that the
  semantic paths are insufficient.

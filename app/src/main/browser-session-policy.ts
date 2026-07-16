import type { Session } from "electron";

export function installBrowserSessionPolicy(session: Session): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.on("will-download", (event) => {
    event.preventDefault();
  });
}

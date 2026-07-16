import net from "node:net";

const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(...args) {
  const options = typeof args[0] === "object" ? args[0] : undefined;
  const host =
    options?.host ?? (typeof args[1] === "string" ? args[1] : undefined);
  const isPipe = options?.path !== undefined || typeof args[0] === "string";
  if (
    !isPipe &&
    host !== undefined &&
    !["127.0.0.1", "::1", "localhost"].includes(host)
  ) {
    throw new Error(`offline MCP verification blocked connection to ${host}`);
  }
  return connect.apply(this, args);
};

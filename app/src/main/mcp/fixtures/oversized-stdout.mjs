import { appendFileSync } from "node:fs";

const statePath = process.env["SANDI_MCP_FIXTURE_STATE"];
const record = (event) => {
  if (statePath) appendFileSync(statePath, `${event}\n`, "utf8");
};

record("start");
record(`pid:${process.pid}`);
process.on("exit", () => record("exit"));
process.stdout.write("x".repeat(9 * 1024 * 1024));
setInterval(() => undefined, 1_000);

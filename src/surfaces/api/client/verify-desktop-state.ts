import { assert, assertEqual } from "@/lib/verification/harness";
import {
  listMonitors,
  listWindows,
  screenshot,
} from "@/surfaces/api/client/desktop-state";
import {
  DeviceImageSchema,
  LocalScreenshotParamsSchema,
} from "@/surfaces/api/devices/protocol";

// The desktop state tools are Windows-only and reach the real display, so this
// check is platform-aware: on Windows it exercises the live enumeration and
// capture path; on any other platform it asserts the tools refuse with a clear
// message rather than guessing at a capture.

async function verifyDesktopState(): Promise<void> {
  verifyImageBoundary();
  if (process.platform === "win32") {
    await verifyOnWindows();
  } else {
    await verifyOnOtherPlatform();
  }
  console.log("desktop state verification passed");
}

function verifyImageBoundary(): void {
  assert(
    !LocalScreenshotParamsSchema.safeParse({ monitor: "0", window: "42" })
      .success,
    "the wire schema rejects mutually exclusive screenshot targets",
  );

  const pngBytes = Buffer.alloc(4_500_000);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngBytes);
  const large = pngBytes.toString("base64");
  assertEqual(
    large.length,
    6_000_000,
    "large fixture exercises the body limit",
  );
  assert(
    DeviceImageSchema.safeParse({ mimeType: "image/png", dataBase64: large })
      .success,
    "multi-megabyte image validation stays stack-safe",
  );
  assert(
    !DeviceImageSchema.safeParse({
      mimeType: "image/png",
      dataBase64: `${large.slice(0, -1)}!`,
    }).success,
    "invalid large base64 returns a validation failure",
  );
  assert(
    !DeviceImageSchema.safeParse({
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgp=",
    }).success,
    "noncanonical base64 pad bits are rejected",
  );
  assert(
    !DeviceImageSchema.safeParse({
      mimeType: "image/png",
      dataBase64: "iVBORw==",
    }).success,
    "a truncated PNG signature is rejected",
  );
  console.log("ok image protocol validation is linear, canonical, and precise");
}

async function verifyOnOtherPlatform(): Promise<void> {
  const monitors = await listMonitors();
  assert(!monitors.ok, "list monitors refuses off Windows");
  assert(
    (monitors.error ?? "").includes("only supported on Windows"),
    "the monitor refusal explains the platform limit",
  );

  const windows = await listWindows();
  assert(!windows.ok, "list windows refuses off Windows");

  const shot = await screenshot({});
  assert(!shot.ok, "screenshot refuses off Windows");
  console.log("ok the desktop state tools refuse on a non-Windows desktop");
}

async function verifyOnWindows(): Promise<void> {
  const monitors = await listMonitors();
  assert(monitors.ok, `list monitors should succeed: ${monitors.error ?? ""}`);
  assert(
    monitors.output.includes("Monitors ("),
    "the monitor listing names how many monitors were found",
  );
  console.log("ok list monitors enumerates the attached displays");

  const windows = await listWindows();
  assert(windows.ok, `list windows should succeed: ${windows.error ?? ""}`);
  assert(
    windows.output.includes("windows") || windows.output.includes("window"),
    "the window listing returns a window summary",
  );
  console.log("ok list windows enumerates the open windows");

  const both = await screenshot({ monitor: "0", window: "anything" });
  assert(
    !both.ok && (both.error ?? "").includes("not both"),
    "a screenshot cannot target a monitor and a window at once",
  );

  const unknown = await screenshot({ monitor: "no-such-monitor-name" });
  assert(
    !unknown.ok && (unknown.error ?? "").includes("no monitor matches"),
    "a screenshot of an unknown monitor refuses with the available ones",
  );
  console.log("ok screenshot validates its monitor and window selectors");

  // The capture itself needs a live desktop session. On an interactive machine
  // it returns a downscaled JPEG; in a headless or session-0 context it can
  // legitimately fail, so a refusal is reported rather than failing the gate.
  const shot = await screenshot({ maxDimension: 640 });
  if (!shot.ok) {
    console.log(
      `ok screenshot capture unavailable in this session (${shot.error ?? "unknown"})`,
    );
    return;
  }
  assert(
    shot.image !== undefined,
    "a successful screenshot carries an image payload",
  );
  assertEqual(
    shot.image?.mimeType,
    "image/jpeg",
    "the screenshot is encoded as JPEG",
  );
  const bytes = Buffer.from(shot.image?.dataBase64 ?? "", "base64");
  assert(
    bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8,
    "the screenshot bytes begin with the JPEG magic number",
  );
  assert(
    shot.output.includes("scaled to") && shot.output.includes("640"),
    "the screenshot is downscaled to the requested longest edge",
  );
  console.log("ok screenshot captures and downscales the primary monitor");
}

await verifyDesktopState();

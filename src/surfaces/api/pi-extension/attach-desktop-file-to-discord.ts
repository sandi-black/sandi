import { request as httpRequest } from "node:http";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { recordDeliverySideEffect } from "../../../lib/provider/side-effects";

const TOOL_BROKER_URL_ENV = "SANDI_TOOL_BROKER_URL";
const TOOL_BROKER_TOKEN_ENV = "SANDI_TOOL_BROKER_TOKEN";
const SURFACE_ENV = "SANDI_SKILLS_SURFACE";
const DISCORD_FILE_PATH = "/discord-file";
const CALL_TIMEOUT_MS = 35_000;
const RESPONSE_MAX_BYTES = 64 * 1024;

type BrokerTarget = { url: string; token: string };
type DiscordFileToolResult = {
  content: [{ type: "text"; text: string }];
  details: { tool: "attach_desktop_file_to_discord"; ok: boolean };
};

export default function attachDesktopFileToDiscord(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "attach_desktop_file_to_discord",
      label: "Attach Desktop File To Discord",
      description:
        "Transfer a bounded file from the human's connected desktop and send it to the current Discord conversation. Use local tools to create or locate the file first.",
      parameters: Type.Object({
        path: Type.String({
          minLength: 1,
          maxLength: 4096,
          description: "Absolute or desktop-relative path to transfer.",
        }),
        desktop: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Desktop id or name from local_list_desktops when more than one is connected.",
          }),
        ),
        name: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 200,
            description: "Safe filename to show in Discord.",
          }),
        ),
        mimeType: Type.Optional(
          Type.String({
            minLength: 3,
            maxLength: 127,
            description:
              "MIME type override. Defaults from the file extension or application/octet-stream.",
          }),
        ),
        content: Type.Optional(
          Type.String({
            maxLength: 2000,
            description: "Optional Discord message accompanying the file.",
          }),
        ),
      }),
      async execute(_id, params, signal) {
        if (process.env[SURFACE_ENV] !== "discord") {
          return result(
            false,
            "attach_desktop_file_to_discord is only available on Discord turns; use attach_to_reply for desktop chat",
          );
        }
        const target = readBrokerTarget();
        if (!target) {
          return result(
            false,
            "no connected desktop is leased for this Discord turn",
          );
        }
        const response = await postDiscordFile(target, params, signal);
        await recordDeliverySideEffect("discord:send-desktop-file");
        return result(
          true,
          `attached ${response.name} (${response.size} bytes) to Discord`,
        );
      },
    }),
  );
}

function result(ok: boolean, text: string): DiscordFileToolResult {
  return {
    content: [{ type: "text", text }],
    details: { tool: "attach_desktop_file_to_discord", ok },
  };
}

export function readBrokerTarget(): BrokerTarget | undefined {
  const rawUrl = process.env[TOOL_BROKER_URL_ENV];
  const token = process.env[TOOL_BROKER_TOKEN_ENV];
  if (!rawUrl || !token || !/^[0-9a-f]{64}$/u.test(token)) return undefined;
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      return undefined;
    }
    return { url: url.origin, token };
  } catch {
    return undefined;
  }
}

export async function postDiscordFile(
  target: BrokerTarget,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ name: string; size: number }> {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolvePost, rejectPost) => {
    let settled = false;
    const settle = (
      action: () => void,
      request?: ReturnType<typeof httpRequest>,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
      request?.destroy();
    };
    const onAbort = (): void => {
      settle(
        () => rejectPost(new Error("Discord desktop-file transfer cancelled")),
        request,
      );
    };
    const timer = setTimeout(() => {
      settle(
        () => rejectPost(new Error("Discord desktop-file transfer timed out")),
        request,
      );
    }, CALL_TIMEOUT_MS);
    const url = new URL(DISCORD_FILE_PATH, target.url);
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${target.token}`,
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let complete = false;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > RESPONSE_MAX_BYTES) {
            settle(
              () =>
                rejectPost(
                  new Error("Discord desktop-file broker reply was too large"),
                ),
              request,
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("aborted", () => {
          settle(
            () =>
              rejectPost(
                new Error(
                  "Discord desktop-file broker reply ended before completion",
                ),
              ),
            request,
          );
        });
        response.on("end", () => {
          if (settled) return;
          complete = true;
          const text = Buffer.concat(chunks).toString("utf8");
          const parsed = parseResponse(text);
          if (response.statusCode !== 200) {
            settle(
              () =>
                rejectPost(
                  new Error(
                    parsed.error ??
                      `Discord desktop-file broker returned status ${response.statusCode ?? 0}`,
                  ),
                ),
              request,
            );
            return;
          }
          if (!parsed.name || parsed.size === undefined) {
            settle(
              () =>
                rejectPost(
                  new Error("Discord desktop-file broker returned bad JSON"),
                ),
              request,
            );
            return;
          }
          settle(() =>
            resolvePost({ name: parsed.name ?? "", size: parsed.size ?? 0 }),
          );
        });
        response.on("close", () => {
          if (complete || settled) return;
          settle(
            () =>
              rejectPost(
                new Error(
                  "Discord desktop-file broker reply closed before completion",
                ),
              ),
            request,
          );
        });
      },
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", (error) => {
      settle(() =>
        rejectPost(
          new Error(`Discord desktop-file transfer failed: ${error.message}`),
        ),
      );
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    request.end(payload);
  });
}

function parseResponse(text: string): {
  error?: string;
  name?: string;
  size?: number;
} {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return {};
    return {
      ...("error" in value && typeof value.error === "string"
        ? { error: value.error }
        : {}),
      ...("name" in value && typeof value.name === "string"
        ? { name: value.name }
        : {}),
      ...("size" in value &&
      typeof value.size === "number" &&
      Number.isSafeInteger(value.size)
        ? { size: value.size }
        : {}),
    };
  } catch {
    return {};
  }
}

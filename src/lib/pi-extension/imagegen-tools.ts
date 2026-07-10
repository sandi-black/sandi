import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { isRecord } from "../type-guards";
import { assetsRoot, dataRoot } from "./roots";
import { textResult } from "./tool-results";
import { z } from "zod/v4";

const PROVIDER = "openai-codex";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_RESPONSE_MODEL = "gpt-5.5";
const IMAGE_MODEL = "gpt-image-2";

const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
const QUALITIES = ["auto", "low", "medium", "high"] as const;
const BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
const OUTPUT_FORMATS = ["png", "webp", "jpeg"] as const;
const THINKING_MODES = ["off", "minimal", "low", "medium", "high"] as const;

type GeneratedImageDetails = {
  provider: string;
  responseModel: string;
  imageModel: string;
  imageId: string;
  savedPath: string;
  metadataPath: string;
  mimeType: string;
  revisedPrompt?: string;
  size: string;
  quality: string;
  background: string;
  outputFormat: string;
  thinking: string;
  referencePaths?: string[];
};

type GeneratedImage = {
  id: string;
  base64: string;
  revisedPrompt?: string;
};

type ImagegenContext = {
  cwd: string;
  model: ExtensionContext["model"];
  modelRegistry: ExtensionContext["modelRegistry"];
};

type OptionalGeneratedImageDetails = Omit<
  GeneratedImageDetails,
  "revisedPrompt" | "referencePaths"
> & {
  revisedPrompt: string | undefined;
  referencePaths: string[] | undefined;
};

type OptionalGeneratedImage = {
  id: string;
  base64: string;
  revisedPrompt: string | undefined;
};

type GeneratedImageParams = {
  prompt: string;
  size?: (typeof SIZES)[number];
  quality?: (typeof QUALITIES)[number];
  background?: (typeof BACKGROUNDS)[number];
  outputFormat?: (typeof OUTPUT_FORMATS)[number];
  thinking?: (typeof THINKING_MODES)[number];
  referencePaths?: string[];
  outputPath?: string;
};

type ImageRequestParams = {
  prompt: string;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  thinking?: string;
  referencePaths?: string[];
};

type RequestInitWithOptionalSignal = Omit<RequestInit, "signal"> & {
  signal?: AbortSignal;
};

const ImageParams = Type.Object({
  prompt: Type.String({ description: "Image description or prompt." }),
  size: Type.Optional(StringEnum(SIZES)),
  quality: Type.Optional(StringEnum(QUALITIES)),
  background: Type.Optional(StringEnum(BACKGROUNDS)),
  outputFormat: Type.Optional(StringEnum(OUTPUT_FORMATS)),
  thinking: Type.Optional(
    StringEnum(THINKING_MODES, {
      description:
        "Dispatcher model reasoning effort before calling image_generation. Use off to omit explicit reasoning. Defaults to low.",
    }),
  ),
  referencePaths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional local image paths to send as visual references. Use the current surface's attachment helper first for uploaded images.",
    }),
  ),
  outputPath: Type.Optional(
    Type.String({
      description:
        "Optional path where the generated image should be saved. Defaults to Sandi's generated image data directory.",
    }),
  ),
});

export default function imagegenToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "image_generate",
      label: "Generate Image",
      description:
        "Generate an image through Pi's OpenAI Codex/ChatGPT image generation session. Saves the image locally and returns an inline image result.",
      promptSnippet:
        "Generate images via OpenAI Codex/ChatGPT subscription image generation.",
      promptGuidelines: [
        "Use image_generate when the user asks to create, generate, draw, render, or make an image.",
        "After generating an image for a surface conversation, use the current surface's send-image helper with the savedPath so the user can see it.",
        "Use the current surface's image-attachment helper first when an uploaded image should be inspected or used as a reference.",
      ],
      parameters: ImageParams,
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const result = await generateImage(
          params,
          signal,
          onUpdate,
          imagegenContext(ctx),
        );
        return {
          content: [
            { type: "text", text: result.text },
            {
              type: "image",
              data: result.image.base64,
              mimeType: result.details.mimeType,
            },
          ],
          details: result.details,
        };
      },
    }),
  );
}

async function generateImage(
  params: GeneratedImageParams,
  signal: AbortSignal | undefined,
  onUpdate:
    | ((result: AgentToolResult<Record<string, unknown>>) => void)
    | undefined,
  ctx: ImagegenContext,
): Promise<{
  image: GeneratedImage;
  text: string;
  details: GeneratedImageDetails;
}> {
  const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
  if (!token) {
    throw new Error(
      "Missing OpenAI Codex OAuth credentials. Run /login in Pi and select the OpenAI ChatGPT/Codex provider.",
    );
  }

  const responseModel =
    ctx.model?.provider === PROVIDER ? ctx.model.id : DEFAULT_RESPONSE_MODEL;
  const sessionId = randomUUID();
  const outputFormat = params.outputFormat ?? "png";
  const body = await buildImageRequest(params, responseModel, sessionId);

  onUpdate?.(
    textResult(`Requesting image from ${PROVIDER}/${IMAGE_MODEL}...`, {
      provider: PROVIDER,
      imageModel: IMAGE_MODEL,
      responseModel,
    }),
  );

  const requestInit: RequestInitWithOptionalSignal = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "chatgpt-account-id": getAccountId(token),
      originator: "sandi-imagegen-extension",
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
      session_id: sessionId,
      "x-client-request-id": sessionId,
      "User-Agent": `sandi-imagegen-extension (${process.platform}; ${process.arch})`,
    },
    body: JSON.stringify(body),
  };
  if (signal) requestInit.signal = signal;

  const response = await fetch(
    `${CODEX_BASE_URL}/codex/responses`,
    requestInit,
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Codex image request failed (${response.status}): ${errorText}`,
    );
  }

  const image = await parseSseForImage(response, signal);
  const savedPath = resolveOutputPath(
    params.outputPath,
    ctx.cwd,
    image.id,
    outputFormat,
  );
  await saveImage(savedPath, image.base64);

  const metadataPath = metadataPathForImage(savedPath);
  const details = optionalDetails({
    provider: PROVIDER,
    responseModel,
    imageModel: IMAGE_MODEL,
    imageId: image.id,
    savedPath,
    metadataPath,
    mimeType: mimeFromFormat(outputFormat),
    revisedPrompt: image.revisedPrompt,
    size: params.size ?? "auto",
    quality: params.quality ?? "auto",
    background: params.background ?? "auto",
    outputFormat,
    thinking: params.thinking ?? "low",
    referencePaths: params.referencePaths,
  });
  await writeFile(
    metadataPath,
    `${JSON.stringify(details, null, 2)}\n`,
    "utf8",
  );

  const lines = [
    `Generated image with ${PROVIDER}/${IMAGE_MODEL}.`,
    `Saved to: ${savedPath}`,
    image.revisedPrompt ? `Revised prompt: ${image.revisedPrompt}` : undefined,
  ].filter((line) => line !== undefined);

  return { image, text: lines.join("\n"), details };
}

async function buildImageRequest(
  params: ImageRequestParams,
  responseModel: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const content: Array<Record<string, string>> = [
    { type: "input_text", text: `Generate this image: ${params.prompt}` },
  ];
  for (const rawPath of params.referencePaths ?? []) {
    const path = resolveAllowedImagePath(rawPath);
    const data = await readFile(path);
    content.push({
      type: "input_image",
      image_url: `data:${mimeFromPath(path)};base64,${data.toString("base64")}`,
    });
  }

  const request: Record<string, unknown> = {
    model: responseModel,
    store: false,
    stream: true,
    instructions:
      "You are an image generation dispatcher. Use the image_generation tool to create exactly the image requested by the user. Do not write code.",
    input: [{ role: "user", content }],
    text: { verbosity: "low" },
    prompt_cache_key: sessionId,
    tool_choice: "auto",
    parallel_tool_calls: true,
    tools: [
      {
        type: "image_generation",
        background: params.background ?? "auto",
        model: IMAGE_MODEL,
        moderation: "auto",
        output_compression: 100,
        output_format: params.outputFormat ?? "png",
        quality: params.quality ?? "auto",
        size: params.size ?? "auto",
      },
    ],
  };

  if ((params.thinking ?? "low") !== "off") {
    request["include"] = ["reasoning.encrypted_content"];
    request["reasoning"] = {
      effort: params.thinking ?? "low",
      summary: "auto",
    };
  }

  return request;
}

async function parseSseForImage(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<GeneratedImage> {
  if (!response.body) {
    throw new Error("No response body from Codex image generation request.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();

        const parsed = parseSseJson(data);
        if (parsed) {
          const image = imageFromSseEvent(parsed);
          if (image) return image;
        }

        index = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error("No image_generation_call result returned by Codex.");
}

function parseSseJson(data: string): Record<string, unknown> | undefined {
  if (!data || data === "[DONE]") return undefined;
  try {
    const parsed = JSON.parse(data);
    if (isRecord(parsed)) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function imageFromSseEvent(
  event: Record<string, unknown>,
): GeneratedImage | undefined {
  if (event["type"] === "error") {
    throw new Error(
      readString(event["message"]) ??
        readString(event["code"]) ??
        "Codex image generation failed.",
    );
  }
  if (event["type"] === "response.failed") {
    const response = event["response"];
    if (isRecord(response)) {
      const error = response["error"];
      if (isRecord(error)) {
        throw new Error(
          readString(error["message"]) ?? "Codex image generation failed.",
        );
      }
    }
    throw new Error("Codex image generation failed.");
  }

  const item = event["item"];
  if (event["type"] !== "response.output_item.done" || !isRecord(item)) {
    return undefined;
  }
  if (item["type"] !== "image_generation_call") return undefined;
  const result = readString(item["result"]);
  const id = readString(item["id"]);
  if (!result || !id) {
    throw new Error("Image generation completed without image data.");
  }
  return optionalGeneratedImage({
    id,
    base64: result,
    revisedPrompt:
      readString(item["revised_prompt"]) ?? readString(item["revisedPrompt"]),
  });
}

function imagegenContext(ctx: ExtensionContext): ImagegenContext {
  return {
    cwd: ctx.cwd,
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
  };
}

function resolveOutputPath(
  path: string | undefined,
  cwd: string,
  imageId: string,
  format: string,
): string {
  if (!path?.trim()) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return join(
      generatedImagesRoot(),
      `${stamp}-${imageId}.${extensionFromFormat(format)}`,
    );
  }
  const raw = path.trim().startsWith("@") ? path.trim().slice(1) : path.trim();
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  if (raw.endsWith("/") || extname(absolute) === "") {
    return join(absolute, `${imageId}.${extensionFromFormat(format)}`);
  }
  return absolute;
}

async function saveImage(path: string, base64: string): Promise<void> {
  assertAllowedImagePath(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(base64, "base64"));
}

function metadataPathForImage(path: string): string {
  const ext = extname(path);
  return ext ? `${path.slice(0, -ext.length)}.json` : `${path}.json`;
}

function resolveAllowedImagePath(path: string): string {
  const raw = path.trim().startsWith("@") ? path.trim().slice(1) : path.trim();
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(raw);
  assertAllowedImagePath(absolute);
  return absolute;
}

function assertAllowedImagePath(path: string): void {
  const absolute = resolve(path);
  const allowed = [
    generatedImagesRoot(),
    surfaceAttachmentsRoot(),
    assetsRoot(),
  ];
  if (!allowed.some((root) => isPathInside(absolute, root))) {
    throw new Error(
      `Image path must be under ${allowed.join(", ")}. Received: ${absolute}`,
    );
  }
}

function generatedImagesRoot(): string {
  return resolve(
    process.env["SANDI_GENERATED_IMAGES_ROOT"]?.trim() ||
      join(dataRoot(), "generated-images"),
  );
}

function surfaceAttachmentsRoot(): string {
  return resolve(
    process.env["SANDI_SURFACE_ATTACHMENTS_ROOT"]?.trim() ||
      join(dataRoot(), "surface-attachments"),
  );
}

function isPathInside(path: string, root: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(normalizedRoot);
}

function mimeFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function mimeFromFormat(format: string): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function extensionFromFormat(format: string): string {
  return format === "jpeg" ? "jpg" : format;
}

function getAccountId(token: string): string {
  const parts = token.split(".");
  const payload = parts[1];
  if (!payload) throw new Error("OpenAI Codex token is not a JWT.");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const claims = CodexAccountClaimsSchema.parse(parsed);
  const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (!accountId)
    throw new Error("Could not read ChatGPT account id from token.");
  return accountId;
}

const CodexAccountClaimsSchema = z.object({
  "https://api.openai.com/auth": z
    .object({ chatgpt_account_id: z.string().optional() })
    .optional(),
});

function optionalGeneratedImage(input: OptionalGeneratedImage): GeneratedImage {
  const image: GeneratedImage = {
    id: input.id,
    base64: input.base64,
  };
  if (input.revisedPrompt) image.revisedPrompt = input.revisedPrompt;
  return image;
}

function optionalDetails(
  input: OptionalGeneratedImageDetails,
): GeneratedImageDetails {
  const details: GeneratedImageDetails = {
    provider: input.provider,
    responseModel: input.responseModel,
    imageModel: input.imageModel,
    imageId: input.imageId,
    savedPath: input.savedPath,
    metadataPath: input.metadataPath,
    mimeType: input.mimeType,
    size: input.size,
    quality: input.quality,
    background: input.background,
    outputFormat: input.outputFormat,
    thinking: input.thinking,
  };
  if (input.revisedPrompt) details.revisedPrompt = input.revisedPrompt;
  if (input.referencePaths && input.referencePaths.length > 0) {
    details.referencePaths = input.referencePaths;
  }
  return details;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

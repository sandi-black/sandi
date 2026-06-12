---
name: image-generation
description: Use for Discord image work: read image attachments, generate images, apply visual references, and send generated image files.
---

# Image Generation

Use this skill when someone asks Sandi to create, generate, draw, render, make,
describe, inspect, edit, remix, or use an image, especially when the image comes
from Discord or the result should be sent back to Discord.

Image generation is an intentional kernel exception to code mode:

- Use the `image_generate` Pi harness tool to generate images. It uses Pi's
  OpenAI/Codex OAuth credentials.
- Do not use raw `OPENAI_API_KEY` image calls from `sandi_js_run`.
- Use `sandi_js_run` only for surrounding file and Discord operations, importing
  Discord helpers:

  ```ts
  import { discord } from "./sandi/runtime.ts";
  ```

Available surfaces:

- `discord.readImageAttachment(...)`: downloads a Discord image attachment and
  returns a local `savedPath`.
- `image_generate`: generates an image through the Pi harness and saves it
  locally.
- `discord.sendImage(...)`: uploads a local image file to Discord.

## Reading Discord Images

When Discord metadata shows an image attachment and the user asks to use that
image as a generation reference, download it first with `sandi_js_run`:

```ts
import { discord } from "./sandi/runtime.ts";

const image = await discord.readImageAttachment();
console.log(JSON.stringify({ savedPath: image.savedPath, mimeType: image.mimeType }));
```

Use `messageId` when the user references another message, and use `attachmentId`
when there are multiple attachments.

## Generating Images

Use `image_generate` when the user wants an actual image made. Keep the prompt
specific enough to capture subject, style, composition, text requirements,
aspect, and any constraints the user gave.

Example `image_generate` input:

```json
{
  "prompt": "A cozy pixel-art greenhouse at night, warm lamps, rain on glass, no text",
  "size": "1536x1024",
  "quality": "high",
  "outputFormat": "png"
}
```

Useful options:

- `size`: `auto`, `1024x1024`, `1536x1024`, or `1024x1536`
- `quality`: `auto`, `low`, `medium`, or `high`
- `background`: `auto`, `opaque`, or `transparent`
- `outputFormat`: `png`, `webp`, or `jpeg`
- `thinking`: `off`, `minimal`, `low`, `medium`, or `high`
- `referencePaths`: local paths from `discord.readImageAttachment` or prior
  generated images

For sticker-like cutouts, icons, sprites, or overlays, consider
`background: "transparent"` and `outputFormat: "png"`.

## Using Discord Images As References

When the user asks to edit, vary, restyle, or use an uploaded image:

1. Use `sandi_js_run` with `discord.readImageAttachment` and print the
   `savedPath`.
2. Pass the returned `savedPath` in `image_generate.referencePaths`.
3. Describe the requested transformation in `prompt`.
4. Use `sandi_js_run` with `discord.sendImage` to post the generated file.

Example `image_generate` input after downloading a reference:

```json
{
  "prompt": "Turn the reference image into a clean vector-style Discord sticker with a transparent background. Preserve the subject's pose and expression.",
  "referencePaths": ["./data/discord-attachments/123/456-image.png"],
  "background": "transparent",
  "outputFormat": "png"
}
```

## Sending Images To Discord

`image_generate` returns a `savedPath`, but that alone is not visible to Discord
users. After generating an image for Discord, send it with `discord.sendImage`:

```ts
import { discord } from "./sandi/runtime.ts";

await discord.sendImage({
  path: "./data/generated-images/2026-05-05T12-00-00-000Z-image.png",
  content: "Here it is.",
});
```

Use the current channel by default. Add `replyToMessageId` when a direct reply
is natural.

## Safety And Fit

- Do not claim to have inspected an image unless an image-capable surface
  actually returned image content to you.
- If the request involves a real person, identity-sensitive content, private
  documents, credentials, medical/legal/financial interpretation, or anything
  potentially harmful, slow down and follow the applicable safety policy.
- If generation fails, say what failed briefly in Discord rather than pretending
  an image was produced.

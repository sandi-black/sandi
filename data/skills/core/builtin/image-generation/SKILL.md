---
name: image-generation
description: Use for image generation work: create, edit, vary, or reference images using Sandi's image-generation harness.
---

# Image Generation

Use this skill when someone asks Sandi to create, generate, draw, render, make,
edit, remix, vary, or use an image.

Image generation is an intentional kernel exception to code mode:

- Use the `image_generate` Pi harness tool to generate images. It uses Pi's
  OpenAI/Codex OAuth credentials.
- Do not use raw `OPENAI_API_KEY` image calls from `sandi_js_run`.
- Use `sandi_js_run` only for surrounding local file or surface operations.

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
- `referencePaths`: local paths from surface attachment helpers or prior
  generated images

For sticker-like cutouts, icons, sprites, overlays, and assets intended to be
composited later, consider `background: "transparent"` and
`outputFormat: "png"`.

## Using References

When the user asks to edit, vary, restyle, or use an uploaded image:

1. Use the current surface's runtime helper to save the image locally.
2. Pass the returned local path in `image_generate.referencePaths`.
3. Describe the requested transformation in `prompt`.
4. Use the current surface's runtime helper to deliver the generated file when
   the result should be visible there.

## Safety And Fit

- Do not claim to have inspected an image unless an image-capable surface
  actually returned image content to you.
- If the request involves a real person, identity-sensitive content, private
  documents, credentials, medical/legal/financial interpretation, or anything
  potentially harmful, slow down and follow the applicable safety policy.
- If generation fails, say what failed briefly rather than pretending an image
  was produced.

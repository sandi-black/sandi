import type { JSX } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { assetUrl, isLocalAbsolutePath } from "./asset-url";

// Sandi's replies as markdown. Local absolute paths in image references are
// routed through the sandi-asset protocol so a screenshot she just wrote to
// disk renders inline; everything else follows react-markdown's default URL
// sanitizer.

function transformUrl(url: string): string {
  if (url.startsWith("sandi-asset://")) return url;
  if (isLocalAbsolutePath(url)) return assetUrl(url);
  return defaultUrlTransform(url);
}

export function MarkdownMessage({ text }: { text: string }): JSX.Element {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={transformUrl}
      >
        {text}
      </Markdown>
    </div>
  );
}

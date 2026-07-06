import { type JSX, memo } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { assetUrl, isLocalAbsolutePath } from "./asset-url";

// Sandi's replies as markdown. Local absolute paths in image references are
// routed through the sandi-asset protocol so a screenshot she just wrote to
// disk renders inline; everything else follows react-markdown's default URL
// sanitizer.
//
// Memoized on its props because a whole markdown re-parse (and, with syntax
// highlighting on, a re-tokenize of every code block) is the most expensive
// thing the transcript does. Settled rows pass stable text, so memo skips them
// entirely while a new turn streams; only the live message, whose text grows
// each delta, actually re-renders.

const EMPTY_REHYPE_PLUGINS: [] = [];
const HIGHLIGHT_REHYPE_PLUGINS = [rehypeHighlight];

function transformUrl(url: string): string {
  if (url.startsWith("sandi-asset://")) return url;
  if (isLocalAbsolutePath(url)) return assetUrl(url);
  return defaultUrlTransform(url);
}

export const MarkdownMessage = memo(function MarkdownMessage({
  text,
  // Syntax highlighting is the heaviest part of a render and is pointless on a
  // half-written code block, so the still-streaming live message renders with
  // it off; the settled row that replaces it on completion highlights once.
  highlight = true,
}: {
  text: string;
  highlight?: boolean;
}): JSX.Element {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={
          highlight ? HIGHLIGHT_REHYPE_PLUGINS : EMPTY_REHYPE_PLUGINS
        }
        urlTransform={transformUrl}
      >
        {text}
      </Markdown>
    </div>
  );
});

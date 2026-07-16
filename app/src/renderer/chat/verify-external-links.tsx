import { MarkdownMessage } from "./MarkdownMessage";
import { renderToStaticMarkup } from "react-dom/server";

const markup = renderToStaticMarkup(
  <MarkdownMessage
    text={'[Electron docs](https://electronjs.org "Reference")'}
  />,
);

expectMarkupToInclude('href="https://electronjs.org"');
expectMarkupToInclude('title="Reference"');
expectMarkupToInclude('target="_blank"');
expectMarkupToInclude('rel="noreferrer"');

const remoteImageMarkup = renderToStaticMarkup(
  <MarkdownMessage text="![tracking pixel](https://example.com/pixel.png)" />,
);
if (remoteImageMarkup.includes("src=")) {
  throw new Error(
    `remote markdown image retained a source: ${remoteImageMarkup}`,
  );
}

console.log("verify-external-links: ok");

function expectMarkupToInclude(expected: string): void {
  if (!markup.includes(expected)) {
    throw new Error(
      `expected rendered markdown to include ${expected}: ${markup}`,
    );
  }
}

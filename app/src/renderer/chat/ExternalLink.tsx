import type { ComponentProps, JSX } from "react";

type ExternalLinkProps = Pick<
  ComponentProps<"a">,
  "children" | "href" | "title"
>;

export function ExternalLink({
  children,
  href,
  title,
}: ExternalLinkProps): JSX.Element {
  return (
    <a href={href} title={title} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

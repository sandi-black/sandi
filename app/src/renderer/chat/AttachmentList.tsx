import type { JSX } from "react";

import { assetUrl } from "./asset-url";
import { guard } from "./guard";

// A file shown in the transcript, whichever side attached it: sandi's reply
// attachments (path plus an optional mimeType, image-ness inferred) and the
// human's own attachments (which already carry an explicit image/file kind)
// both render through here. Images render inline with a hover save button;
// other files show as chips with an explicit save action.
export type DisplayAttachment = {
  path: string;
  name?: string;
  mimeType?: string;
  kind?: "image" | "file";
};

function isImage(attachment: DisplayAttachment): boolean {
  // Trust an explicit kind (the human's attachments carry one, classified when
  // they were staged) over guessing from the path or mimeType.
  if (attachment.kind) return attachment.kind === "image";
  if (attachment.mimeType?.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif)$/i.test(attachment.path);
}

function displayName(attachment: DisplayAttachment): string {
  if (attachment.name) return attachment.name;
  const parts = attachment.path.split(/[\\/]/);
  return parts[parts.length - 1] ?? attachment.path;
}

export function AttachmentList({
  attachments,
}: {
  attachments: DisplayAttachment[];
}): JSX.Element | null {
  if (attachments.length === 0) return null;
  const images = attachments.filter(isImage);
  const files = attachments.filter((candidate) => !isImage(candidate));
  return (
    <>
      {images.map((attachment) => (
        <div className="attachment-image" key={attachment.path}>
          <img src={assetUrl(attachment.path)} alt={displayName(attachment)} />
          <button
            type="button"
            className="save-overlay"
            onClick={() =>
              guard(
                window.sandiChat.saveAttachmentAs(attachment),
                `could not save ${displayName(attachment)}`,
              )
            }
          >
            Save
          </button>
        </div>
      ))}
      {files.length > 0 && (
        <div className="attachment-row">
          {files.map((attachment) => (
            <span className="attachment-chip" key={attachment.path}>
              <span className="chip-name" title={attachment.path}>
                {displayName(attachment)}
              </span>
              <button
                type="button"
                title="Save as..."
                onClick={() =>
                  guard(
                    window.sandiChat.saveAttachmentAs(attachment),
                    `could not save ${displayName(attachment)}`,
                  )
                }
              >
                save
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

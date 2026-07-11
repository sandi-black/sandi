import { assert, assertEqual } from "@/lib/verification/harness";
import { deliverDesktopFileToDiscord } from "@/surfaces/discord/bot/desktop-file-delivery";

export async function verifyDesktopFileDelivery(): Promise<void> {
  const sent: unknown[] = [];
  await deliverDesktopFileToDiscord({
    channel: {
      async send(options) {
        sent.push(options);
      },
    },
    delivery: {
      content: "Ada's diagram",
      attachment: {
        name: "ada.png",
        mimeType: "image/png",
        size: 8,
        dataBase64: "iVBORw0KGgo=",
      },
    },
    replyToMessageId: "message-1",
  });
  assertEqual(sent.length, 1, "one transfer sends one Discord message");
  const encoded = JSON.stringify(sent[0]);
  assert(encoded.includes("Ada's diagram"), "the upload keeps its content");
  assert(
    encoded.includes("message-1"),
    "the upload replies to the bound message",
  );
  assert(
    encoded.includes("ada.png"),
    "the upload keeps the validated filename",
  );

  let error = "";
  try {
    await deliverDesktopFileToDiscord({
      channel: {
        async send() {
          throw new Error("Discord rejected upload");
        },
      },
      delivery: {
        attachment: {
          name: "ada.png",
          mimeType: "image/png",
          size: 8,
          dataBase64: "iVBORw0KGgo=",
        },
      },
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  assert(
    error.includes("Discord rejected upload"),
    "Discord upload failure propagates to the broker callback",
  );
  console.log(
    "ok desktop file delivery preserves metadata and upload failures",
  );
}

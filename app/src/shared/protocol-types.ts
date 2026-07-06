// Renderer-safe mirrors of the server wire types in
// src/surfaces/api/devices/protocol.ts. The renderer must not import server
// source (its bundle would drag in node builtins), so the shapes it needs are
// restated here as plain types. verify-response-buffer.ts asserts, in a node
// context that can see both modules, that these stay assignable to the server's
// zod-inferred types in both directions; a drift fails the check.

export type ResponseChunk =
  | {
      type: "delta";
      turnId: string;
      seq: number;
      channel: "text" | "thinking";
      delta: string;
    }
  | {
      type: "end";
      turnId: string;
      seq: number;
    };

// An attachment sandi adds to her reply via the attach_to_reply tool: a
// hands-local path on this machine, relayed over the device link.
export type ResponseAttachment = {
  turnId: string;
  seq: number;
  path: string;
  name?: string;
  mimeType?: string;
};

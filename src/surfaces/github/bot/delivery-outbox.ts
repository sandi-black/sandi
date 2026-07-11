import { createHash } from "node:crypto";

import { z } from "zod/v4";
import {
  AmbiguousDeliveryError,
  type DeliveryRecord,
  type DurableOutbox,
} from "@/lib/delivery/outbox";
import { errorMessage } from "@/lib/errors";
import type { IssueComment, ReviewComment } from "@/surfaces/github/github/api";

export const GITHUB_COMMENT_DELIVERY = "github-comment-v1";

const GitHubCommentPayloadSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  chunks: z.array(z.string().min(1)).min(1),
  firstReviewCommentId: z.number().int().positive().optional(),
});
const GitHubCommentProgressSchema = z.object({
  nextChunk: z.number().int().nonnegative(),
  commentIds: z.array(z.number().int().positive()),
});

export type GitHubDeliveryApi = {
  listIssueComments(input: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<IssueComment[]>;
  listReviewComments(input: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<ReviewComment[]>;
  createIssueComment(input: {
    owner: string;
    repo: string;
    number: number;
    body: string;
  }): Promise<IssueComment>;
  replyToReviewComment(input: {
    owner: string;
    repo: string;
    number: number;
    commentId: number;
    body: string;
  }): Promise<ReviewComment>;
};

export function registerGitHubCommentDelivery(
  outbox: DurableOutbox,
  api: GitHubDeliveryApi,
): void {
  outbox.register(GITHUB_COMMENT_DELIVERY, async (record, signal) => {
    signal.throwIfAborted();
    const payload = GitHubCommentPayloadSchema.parse(record.payload);
    const progress = GitHubCommentProgressSchema.parse(
      record.progress ?? { nextChunk: 0, commentIds: [] },
    );
    const chunk = payload.chunks[progress.nextChunk];
    if (chunk === undefined) {
      return {
        status: "complete",
        result: { commentIds: progress.commentIds },
      };
    }
    const marker = deliveryMarker(record, progress.nextChunk);
    let commentId: number | undefined;
    if (record.attempts > 1) {
      const comments =
        progress.nextChunk === 0 && payload.firstReviewCommentId !== undefined
          ? await api.listReviewComments(payload)
          : await api.listIssueComments(payload);
      commentId = comments.find((comment) =>
        comment.body?.includes(marker),
      )?.id;
    }
    signal.throwIfAborted();
    if (commentId === undefined) {
      try {
        const body = `${chunk}\n\n${marker}`;
        const comment =
          progress.nextChunk === 0 && payload.firstReviewCommentId !== undefined
            ? await api.replyToReviewComment({
                ...payload,
                commentId: payload.firstReviewCommentId,
                body,
              })
            : await api.createIssueComment({ ...payload, body });
        commentId = comment.id;
      } catch (error) {
        // GitHub has no idempotency header for comments. A stable hidden marker
        // lets the retry search the thread before reposting when the POST may
        // have succeeded but its acknowledgement was lost.
        throw new AmbiguousDeliveryError(errorMessage(error), { cause: error });
      }
    }
    const next = {
      nextChunk: progress.nextChunk + 1,
      commentIds: [...progress.commentIds, commentId],
    };
    if (next.nextChunk < payload.chunks.length) {
      return { status: "progress", progress: next };
    }
    return { status: "complete", result: { commentIds: next.commentIds } };
  });
}

export async function enqueueGitHubComments(input: {
  outbox: DurableOutbox;
  idempotencyKey: string;
  payload: z.input<typeof GitHubCommentPayloadSchema>;
}): Promise<void> {
  const record = await input.outbox.enqueue({
    idempotencyKey: input.idempotencyKey,
    kind: GITHUB_COMMENT_DELIVERY,
    payload: GitHubCommentPayloadSchema.parse(input.payload),
  });
  if (
    !input.outbox.isDelivering() &&
    (record.status === "pending" || record.status === "processing")
  ) {
    await input.outbox.deliverNow(input.idempotencyKey);
  }
}

function deliveryMarker(record: DeliveryRecord, index: number): string {
  const digest = createHash("sha256")
    .update(`${record.idempotencyKey}:${index}`)
    .digest("hex");
  return `<!-- sandi-delivery:${digest} -->`;
}

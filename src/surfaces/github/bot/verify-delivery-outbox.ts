import assert from "node:assert/strict";
import { join } from "node:path";

import { DurableOutbox } from "@/lib/delivery/outbox";
import { withTempDir } from "@/lib/verification/harness";
import {
  enqueueGitHubComments,
  type GitHubDeliveryApi,
  registerGitHubCommentDelivery,
} from "@/surfaces/github/bot/delivery-outbox";
import type {
  GitHubUser,
  IssueComment,
  ReviewComment,
} from "@/surfaces/github/github/api";

async function verifyGitHubDeliveryOutbox(): Promise<void> {
  await withTempDir("sandi-github-outbox-", async (root) => {
    let now = Date.parse("2026-07-10T05:00:00.000Z");
    const outbox = new DurableOutbox(join(root, "outbox.json"), {
      now: () => now,
      retryBaseMs: 10,
      retryMaxMs: 100,
      claimLeaseMs: 100,
      pollMaxMs: 100,
    });
    const api = new MarkerAwareGitHubApi();
    registerGitHubCommentDelivery(outbox, api);
    await enqueueGitHubComments({
      outbox,
      idempotencyKey: "github:response:grace-trigger",
      payload: {
        owner: "grace",
        repo: "compiler",
        number: 1,
        chunks: ["first", "second"],
      },
    });
    assert.equal(
      (await outbox.get("github:response:grace-trigger"))?.lastError?.class,
      "ambiguous",
    );
    now += 10;
    const record = await outbox.deliverNow("github:response:grace-trigger");
    assert.equal(record?.status, "completed");
    assert.equal(record?.attempts, 3);
    assert.equal(
      api.comments.length,
      2,
      "the hidden marker deduplicates retry",
    );
    assert(
      api.comments.every((comment) => comment.body?.includes("sandi-delivery")),
    );
  });
}

class MarkerAwareGitHubApi implements GitHubDeliveryApi {
  readonly comments: IssueComment[] = [];
  #loseFirstAcknowledgement = true;

  listIssueComments(): Promise<IssueComment[]> {
    return Promise.resolve(this.comments);
  }

  listReviewComments(): Promise<ReviewComment[]> {
    return Promise.resolve([]);
  }

  async createIssueComment(input: { body: string }): Promise<IssueComment> {
    const comment = issueComment(this.comments.length + 1, input.body);
    this.comments.push(comment);
    if (this.#loseFirstAcknowledgement) {
      this.#loseFirstAcknowledgement = false;
      throw new Error("acknowledgement was lost");
    }
    return comment;
  }

  replyToReviewComment(): Promise<ReviewComment> {
    return Promise.reject(new Error("unexpected review reply"));
  }
}

function issueComment(id: number, body: string): IssueComment {
  return {
    id,
    body,
    html_url: `https://example.test/comments/${id}`,
    created_at: "2026-07-10T05:00:00.000Z",
    updated_at: "2026-07-10T05:00:00.000Z",
    user: githubUser(),
  };
}

function githubUser(): GitHubUser {
  return { id: 1, login: "grace-hopper" };
}

await verifyGitHubDeliveryOutbox();
console.log("GitHub delivery outbox verification passed");

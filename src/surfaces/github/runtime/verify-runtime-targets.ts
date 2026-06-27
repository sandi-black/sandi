import assert from "node:assert/strict";

import {
  CommentInputSchema,
  CreatePullRequestReviewInputSchema,
  ReplyToReviewCommentInputSchema,
  resolveRepoIssueTarget,
} from "@/surfaces/github/runtime/targets";

const FALLBACK = { owner: "sandi-black", repo: "sandi", number: 52 };

// An explicit owner/repo/number resolves to itself and overrides the fallback.
assert.deepEqual(
  resolveRepoIssueTarget(
    { owner: "earendil", repo: "pi", number: 7 },
    FALLBACK,
  ),
  { owner: "earendil", repo: "pi", number: 7 },
);

// Missing fields fall back to the current thread's context.
assert.deepEqual(resolveRepoIssueTarget({ number: 9 }, FALLBACK), {
  owner: "sandi-black",
  repo: "sandi",
  number: 9,
});
assert.deepEqual(resolveRepoIssueTarget({}, FALLBACK), FALLBACK);

// A turn from another surface with no fallback must name every field.
assert.throws(
  () => resolveRepoIssueTarget({ owner: "earendil", repo: "pi" }, undefined),
  /Provide owner, repo, and number/,
);

// Malformed boundary values are rejected: blank owner/repo, non-positive or
// non-integer number.
assert.throws(() => resolveRepoIssueTarget({ owner: "  " }, FALLBACK));
assert.throws(() => resolveRepoIssueTarget({ repo: "" }, FALLBACK));
assert.throws(() => resolveRepoIssueTarget({ number: 0 }, FALLBACK));
assert.throws(() => resolveRepoIssueTarget({ number: -3 }, FALLBACK));
assert.throws(() => resolveRepoIssueTarget({ number: 1.5 }, FALLBACK));

// The action input schemas parse the repo fields too, so a blank owner is
// rejected at the input boundary, not only at final target validation.
assert.equal(CommentInputSchema.parse({ body: "hi" }).body, "hi");
assert.throws(() => CommentInputSchema.parse({ body: "" }));
assert.throws(() => CommentInputSchema.parse({ owner: "  ", body: "hi" }));
assert.equal(
  ReplyToReviewCommentInputSchema.parse({ commentId: 5, body: "ok" }).commentId,
  5,
);
assert.throws(() =>
  ReplyToReviewCommentInputSchema.parse({ commentId: 0, body: "ok" }),
);
assert.equal(
  CreatePullRequestReviewInputSchema.parse({ body: "lgtm", event: "APPROVE" })
    .event,
  "APPROVE",
);
assert.throws(() =>
  CreatePullRequestReviewInputSchema.parse({ body: "x", event: "MAYBE" }),
);

console.log("github runtime targets verification passed");

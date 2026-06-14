---
name: context-search-tuning
description: Use when auditing, debugging, or tuning Sandi's skill search, memory search, prompt-time context hints, retrieval thresholds, BM25/embedding behavior, passage aggregation, or false positive/false negative skill and memory matches.
---

# Context Search Tuning

Use this skill when Sandi's skill or memory retrieval seems noisy, misses an
important result, suggests irrelevant context, or needs parameter changes.

## Default Stance

Treat search tuning as an evaluation problem first and an implementation problem
second. Reproduce the prompt, inspect the ranked candidates with scores and match
evidence, then tune against a small representative prompt set. Prefer changes
that improve general retrieval behavior over one-off keyword patches.

For prompt-time hints, bias toward useful recall when hints include enough
evidence for Sandi to ignore false positives. For full search tools, preserve
recall and make ranking explainable rather than hiding plausible matches.

## Audit Workflow

1. Capture the exact user prompt, surface, participant context, and expected
   skill or memory result.
2. Inspect the compiled prompt section if the issue is about automatic hints.
   Check whether the hint shows the candidate, description or summary, match
   score, match type, and why it matched.
3. Run the closest search tool manually:
   - use `skill_search` for reusable workflow/instruction misses;
   - use `memory_search` for prior context, preferences, decisions, or project
     state misses;
   - pass a focused query and then a paraphrase of the original prompt.
4. Read the full candidate only after its metadata or match reason looks
   plausible. Use `skill_read` or `memory_read`.
5. Compare automatic hints, explicit tool search, and the expected result. Note
   whether the problem is retrieval, ranking, filtering, stale content, bad
   descriptions/summaries, or missing durable context.
6. Build a tiny eval set before changing code or skill text. Include:
   - the failing prompt;
   - one or two nearby prompts that should still match;
   - at least one prompt that should not trigger the same hint.
7. Tune the smallest stable surface: descriptions or summaries first, thresholds
   or query expansion next, retrieval code last.
8. Re-run the eval set and the closest repository verification command before
   reporting success.

## Interpreting Results

- `matched by hybrid` usually means the result has both semantic similarity and
  useful exact terms.
- `matched by embedding` can be correct for paraphrases and related concepts,
  but inspect the match reason before trusting a broad result.
- High BM25 with weak embedding often means exact wording is carrying the result;
  this is useful for names, acronyms, refs, code terms, and quoted phrases.
- High embedding with no BM25 is useful for conceptual matches, but it can make
  broad procedural skills look relevant. Prefer evidence-bearing hints over
  aggressive suppression.
- If a memory result is relevant only because of body text, consider whether its
  summary should be improved so future hints can stay compact.
- If a skill result is relevant only because of one hidden body passage, consider
  whether the description should mention that trigger area.

## Tuning Rules

- Do not tune against a single anecdote without checking nearby prompts.
- Do not add domain-specific stopwords or synonyms unless the domain is truly a
  durable retrieval concept.
- Prefer parent/passage indexing over whole-document embeddings for long skills
  and memories.
- Prefer parent-level aggregation that exposes the best passage and a few
  supporting passages, rather than flattening chunks as independent results.
- Keep automatic hints smaller than explicit search results, but include enough
  match evidence that Sandi can ignore weak candidates.
- Avoid injecting full memory bodies into prompt-time hints. Show refs,
  summaries, scores, and matched passage labels instead.
- Search tools may return snippets because the user or model explicitly asked to
  search. Prompt-time memory hints should stay more compact.
- When embeddings are disabled or unavailable, confirm whether fallback lexical
  behavior is expected before changing thresholds.

## Common Fixes

- Missing obvious skill: improve the skill description, add a focused passage in
  the skill body, or lower prompt-hint filtering only if the miss generalizes.
- Missing obvious memory: improve the memory summary, move durable facts into a
  better-scoped memory file, or verify the current conversation is allowed to see
  that memory area.
- Too many broad skills: tighten prompt-hint top-score filtering or improve
  broad skill descriptions so their match evidence is easier to reject.
- Exact item names missed: keep BM25 in explicit search and hybrid prompt hints;
  semantic-only search often misses spellings, acronyms, refs, and code terms.
- Stale result ranks too high: update or delete stale skill/memory content
  rather than suppressing the retriever globally.

## Repository Debugging

When editing Sandi's retrieval implementation, inspect these areas:

- `src/lib/retrieval/embeddings.ts` for local embedding engine config, batching,
  and cache behavior.
- `src/lib/retrieval/bm25.ts` for lexical scoring and stopwords.
- `src/lib/retrieval/hybrid-search.ts` for score combination, thresholds, and
  lexical modes.
- `src/lib/retrieval/parent-search.ts` for passage construction and parent
  aggregation.
- `src/lib/pi-extension/skill-hybrid-search.ts` and
  `src/lib/pi-extension/memory-hybrid-search.ts` for domain-specific passage
  construction and query expansion.
- `src/lib/context/skills.ts` and `src/lib/context/memory.ts` for prompt-time
  hint filtering and formatting.
- `src/lib/context/verify-source-grounding.ts` for deterministic retrieval
  fixture coverage.

Useful checks:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run verify:source-grounding
npm run check
```

For live runtime tuning, inspect the active data root and sample recent
conversation prompts before changing parameters. Keep live custom skill or memory
edits separate from checked-in builtin changes unless the user asks for both.

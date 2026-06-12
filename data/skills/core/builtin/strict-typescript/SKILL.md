---
name: strict-typescript
description: Use for strict TypeScript coding, review, refactors, debugging, parsing, validation, API boundaries, tests, or compiler/lint fixes.
---

# Strict TypeScript

Use this skill whenever TypeScript correctness matters. The goal is boring,
readable code that lets the compiler prove as much as possible and keeps unsafe
input at the edge of the system.

## Core Rules

- Inspect the local `tsconfig`, lint config, package scripts, and nearby modules
  before choosing patterns.
- Prefer the repo's existing helpers and domain modules over new abstractions.
- Keep `strict` mode happy without weakening types.
- Avoid `any`, non-null assertions, and type assertions.
- Model uncertain values as `unknown` at boundaries, then narrow with parsers,
  schema validators, tagged unions, or small type guards.
- Prefer exact object shapes and explicit return types at exported boundaries.
- Keep changes scoped. Do not turn a focused fix into a broad rewrite.

## Boundary Handling

Most strict TypeScript wins happen where data enters the program:

- Parse JSON into `unknown`, then validate it before use.
- Use schema libraries already present in the project, such as Zod, when they fit.
- Reject arrays before treating a value as `Record<string, unknown>`.
- Validate numbers with full-string checks instead of partial parses such as
  `Number.parseInt("12abc", 10)`.
- Surface malformed external data with clear errors that include the failing
  boundary, not vague downstream symptoms.

When indexing arrays, maps, records, or regex captures, handle the missing case
explicitly. With `noUncheckedIndexedAccess`, an index result is allowed to be
absent even when it usually exists.

## Type Modeling

- Use discriminated unions for state machines, variants, event payloads, and
  mode-specific parameters.
- Prefer `readonly` arrays and objects for data that should not be mutated.
- Preserve `exactOptionalPropertyTypes`: omit optional fields instead of assigning
  `undefined` when the type does not allow it.
- Use `satisfies` to check literals while preserving narrow types.
- Keep generic helpers small and named for the invariant they protect.

## Implementation Style

- Use `const` by default.
- Prefer early returns over deep nesting.
- Keep functions small enough that parameter and return types remain obvious.
- Add comments only around non-obvious invariants or tricky external behavior.
- Do not add an abstraction unless it removes real duplication or clarifies a
  repeated domain concept.

## Verification

Use the project's own gate. Common examples:

```sh
bun run check
npm run check
npm run typecheck
npm run lint
```

If the check fails, fix the strictness issue directly instead of hiding it behind
casts or weaker compiler settings.

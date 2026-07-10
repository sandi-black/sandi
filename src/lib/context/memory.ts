import { access, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type {
  ConversationManifest,
  ConversationMemoryScope,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { participantMemoryRef } from "@/lib/identity/types";
import { normalizeRefPrefix } from "@/lib/memory-refs";
import type { MemoryContext as ToolMemoryContext } from "@/lib/pi-extension/memory-common";
import {
  type MemoryHybridSearchResponse,
  searchMemoryHybrid,
} from "@/lib/pi-extension/memory-hybrid-search";
import type { EmbeddingEngine } from "@/lib/retrieval/embeddings";

export type MemoryContext = {
  memoryRoot: string;
  conversation?: ConversationManifest;
  memoryScopes: ConversationMemoryScope[];
  participants: ConversationParticipant[];
};

type MemoryScope = {
  label: string;
  dir: string;
  refPrefix: string;
};

type ScannedScope = {
  mainMemory: { ref: string; content: string } | null;
};

const PROMPT_MEMORY_HINT_LIMIT = 5;
const PROMPT_MEMORY_HINT_MIN_SCORE = 0.3;
const PROMPT_MEMORY_HINT_TOP_RATIO = 0.85;

export function buildMemoryContext(input: {
  dataDir: string;
  conversation?: ConversationManifest;
  participants: ConversationParticipant[];
}): MemoryContext {
  const context: MemoryContext = {
    memoryRoot: join(input.dataDir, "memory"),
    memoryScopes: input.conversation?.memoryScopes ?? [],
    participants: input.participants,
  };
  if (input.conversation) context.conversation = input.conversation;
  return context;
}

export async function loadMemory(
  context: MemoryContext,
  hintQuery?: string,
  options: {
    embeddingEngine?: EmbeddingEngine | null | undefined;
  } = {},
): Promise<string> {
  const scopes = memoryScopes(context);
  const [scanned, hints] = await Promise.all([
    Promise.all(
      scopes.map(async (scope) => ({
        scope,
        memory: await scanScope(scope),
      })),
    ),
    searchMemoryHints(context, hintQuery, options.embeddingEngine),
  ]);

  return formatMemoryOverview(
    context,
    scanned
      .map(({ scope, memory }) => formatScratchpad(scope.label, memory))
      .filter((section): section is string => section !== null),
    hints,
  );
}

function memoryScopes(context: MemoryContext): MemoryScope[] {
  const root = context.memoryRoot;
  const scopes: MemoryScope[] = [
    {
      label: "System",
      dir: join(root, "system"),
      refPrefix: "system",
    },
    {
      label: "Self",
      dir: join(root, "self"),
      refPrefix: "self",
    },
    {
      label: "Household",
      dir: join(root, "household"),
      refPrefix: "household",
    },
  ];

  scopes.push(
    ...context.memoryScopes.map((scope) => scopeFromRef(root, scope)),
  );

  for (const participant of context.participants) {
    scopes.push({
      label: `User: ${participant.username}`,
      dir: join(root, participant.platform, participant.platformUserId),
      refPrefix: `${participant.platform}/${participant.platformUserId}`,
    });
  }

  return scopes;
}

function scopeFromRef(
  root: string,
  scope: ConversationMemoryScope,
): MemoryScope {
  const refPrefix = normalizeRefPrefix(scope.refPrefix);
  return {
    label: scope.label,
    dir: resolveMemoryRef(root, refPrefix),
    refPrefix,
  };
}

async function scanScope(scope: MemoryScope): Promise<ScannedScope> {
  const memoryPath = join(scope.dir, "MEMORY.md");
  const mainMemoryContent = await readIfExists(memoryPath);
  const mainMemory =
    mainMemoryContent === null
      ? null
      : {
          ref: `${scope.refPrefix}/MEMORY.md`,
          content: mainMemoryContent,
        };

  return { mainMemory };
}

function formatMemoryOverview(
  context: MemoryContext,
  scratchpads: string[],
  hints: MemoryHybridSearchResponse | null,
): string {
  const areas = [
    "- system: machine, sandbox, tooling, paths, and runtime environment details",
    "- self: Sandi's own durable self-continuity",
    "- household: shared context for Sandi and the active group",
    "- participant platform arenas: active participant memory only",
    "- topics: recurring household topics and projects",
    "- surfaces/<surface>/threads: surface-provided thread conversation scopes",
    "- surfaces/<surface>/channels: surface-provided room or channel conversation scopes",
  ];
  const activeUsers = context.participants.map((participant) => {
    const identity = participant.identityId
      ? `, identity ${participant.identityId}`
      : "";
    return `  - ${participant.username}: ${participantMemoryRef(participant)}${identity}`;
  });
  const currentArchive = currentArchiveLine(context.conversation);

  return [
    "Available memory areas:",
    ...areas,
    "",
    "Active user memory refs:",
    ...(activeUsers.length > 0 ? activeUsers : ["  - none"]),
    currentArchive,
    "",
    "Use memory_search for prior context, memory_list to inspect an area, and memory_read for details. Prefer searching before assuming an older detail is absent.",
    "",
    scratchpads.length > 0
      ? ["Visible scratchpads:", ...scratchpads].join("\n\n")
      : "Visible scratchpads: none",
    ...formatMemoryHintSection(hints),
  ].join("\n");
}

function currentArchiveLine(
  conversation: ConversationManifest | undefined,
): string {
  if (!conversation) return "Current conversation memory area: none";
  if (conversation.memoryScopes.length === 0) {
    return "Current conversation memory area: none";
  }
  return conversation.memoryScopes
    .map((scope) => `${scope.label} area: ${scope.refPrefix}`)
    .join("\n");
}

function formatScratchpad(label: string, scope: ScannedScope): string | null {
  if (!scope.mainMemory) return null;
  return [
    `== ${label} ==`,
    `Scratchpad (${scope.mainMemory.ref}):`,
    scope.mainMemory.content.trimEnd(),
  ].join("\n");
}

async function searchMemoryHints(
  context: MemoryContext,
  hintQuery: string | undefined,
  embeddingEngine: EmbeddingEngine | null | undefined,
): Promise<MemoryHybridSearchResponse | null> {
  const query = hintQuery?.trim();
  if (!query) return null;
  if (shouldSkipPromptMemoryHints(query)) return null;

  const response = await searchMemoryHybrid({
    root: context.memoryRoot,
    context: toolMemoryContext(context),
    query,
    contentMode: "passages",
    lexicalMode: "boost",
    maxResults: PROMPT_MEMORY_HINT_LIMIT,
    maxSnippets: 1,
    minScore: 0.24,
    minEmbeddingScore: 0.2,
    supportingScoreWeight: 0,
    embeddingEngine,
  });
  const results = filterPromptMemoryHints(response.results);
  return results.length > 0 ? { ...response, results } : null;
}

function formatMemoryHintSection(
  hints: MemoryHybridSearchResponse | null,
): string[] {
  if (!hints || hints.results.length === 0) return [];
  return [
    "",
    "Potentially relevant memories to the prompt:",
    ...hints.results.flatMap((result) => {
      const lines = [
        result.summary
          ? `- ${result.ref}: ${result.summary}`
          : `- ${result.ref}`,
        `  match: ${formatHintSignals(result)}`,
      ];
      const reason = memoryHintReason(result.snippets[0]);
      if (reason) lines.push(`  why: ${reason}`);
      return lines;
    }),
    "These are hints only. Read a listed memory if it actually applies; ignore false positives.",
  ];
}

function shouldSkipPromptMemoryHints(query: string): boolean {
  return isCasualAcknowledgement(query) || isGenericMemoryRecall(query);
}

function filterPromptMemoryHints(
  results: MemoryHybridSearchResponse["results"],
): MemoryHybridSearchResponse["results"] {
  const topScore = results[0]?.score ?? 0;
  if (topScore === 0) return [];
  return results.filter(
    (result) =>
      result.score >=
        Math.max(
          PROMPT_MEMORY_HINT_MIN_SCORE,
          topScore * PROMPT_MEMORY_HINT_TOP_RATIO,
        ) &&
      (result.matchedBy === "hybrid" ||
        result === results[0] ||
        (result.embeddingScore !== null && result.embeddingScore >= 0.2)),
  );
}

function isCasualAcknowledgement(query: string): boolean {
  const normalized = normalizeQuery(query);
  if (hasActionIntent(normalized)) return false;
  const casual = normalized.replace(/[.!?,]+/gu, "").trim();
  return (
    casual.length <= 80 &&
    /^(yo|hi|hello|hey|yes|no|ok|okay|nice|great|fantastic|awesome|yay|yay good job|good job|looks right|sounds good|thank you|thanks|alright|merged|accepted)$/u.test(
      casual,
    )
  );
}

function isGenericMemoryRecall(query: string): boolean {
  const normalized = normalizeQuery(query);
  if (
    !hasAny(normalized, [
      "remember",
      "memory",
      "previous",
      "before",
      "what did we",
      "decided",
    ])
  ) {
    return false;
  }
  return !hasAnyRegex(normalized, [
    /\b(remind me|remember to|todo|to do|task|schedule|appointment|appt)\b/u,
    /\b(food|restaurant|doordash|google maps|bdo|black desert|game|dice)\b/u,
    /\b(skill|code|repo|branch|pull request|pr|deploy|runtime|prompt|context)\b/u,
    /\b(image|generate|draw|look up|search|research|tweet|docs|http)\b/u,
  ]);
}

function hasActionIntent(normalized: string): boolean {
  return hasAnyRegex(normalized, [
    /\b(can you|could you|please|let's|lets|i want|should we|what would|how do|how does)\b/u,
    /\b(make|create|add|update|change|fix|implement|look up|search|research|read about|generate|open|write|run|test|debug|deploy|restart|explain|compare|find|fetch|calculate|plan|review|format|remind|schedule|investigate)\b/u,
  ]);
}

function normalizeQuery(query: string): string {
  return query.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function hasAnyRegex(value: string, regexes: RegExp[]): boolean {
  return regexes.some((regex) => regex.test(value));
}

function formatHintSignals(
  result: MemoryHybridSearchResponse["results"][number],
) {
  const embedding =
    result.embeddingScore === null
      ? "embedding n/a"
      : `embedding ${result.embeddingScore.toFixed(3)}`;
  return [
    `score ${result.score.toFixed(3)}`,
    embedding,
    `bm25 ${result.bm25Score.toFixed(3)}`,
    `matched by ${result.matchedBy}`,
  ].join(", ");
}

function memoryHintReason(snippet: string | undefined): string | null {
  if (!snippet) return null;
  const label = snippetLabel(snippet);
  if (!label) return "matched a memory passage";
  if (label === "metadata") return "matched memory ref or summary metadata";
  return `matched ${label} passage`;
}

function snippetLabel(snippet: string): string | null {
  const colonIndex = snippet.indexOf(":");
  if (colonIndex <= 0) return null;
  return snippet.slice(0, colonIndex).trim() || null;
}

function toolMemoryContext(context: MemoryContext): ToolMemoryContext {
  return {
    memoryScopes: context.memoryScopes.map((scope) => {
      const memoryScope = {
        label: scope.label,
        refPrefix: scope.refPrefix,
      };
      return scope.area ? { ...memoryScope, area: scope.area } : memoryScope;
    }),
    participants: context.participants.map((participant) => {
      const memoryParticipant = {
        platform: participant.platform,
        platformUserId: participant.platformUserId,
        ref: participantMemoryRef(participant),
        username: participant.username,
      };
      return participant.identityId
        ? { ...memoryParticipant, identityId: participant.identityId }
        : memoryParticipant;
    }),
  };
}

async function readIfExists(filepath: string): Promise<string | null> {
  try {
    await access(filepath);
    return await readFile(filepath, "utf8");
  } catch {
    return null;
  }
}

function resolveMemoryRef(root: string, refPrefix: string): string {
  const absolute = resolve(root, refPrefix);
  const relativePath = relative(root, absolute);
  if (
    relativePath.startsWith("..") ||
    relativePath === "" ||
    relativePath.includes(`..${sep}`)
  ) {
    throw new Error(`Invalid memory scope ref prefix: ${refPrefix}`);
  }
  return absolute;
}

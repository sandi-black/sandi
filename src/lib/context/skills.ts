import { formatSkillSource } from "@/lib/pi-extension/skill-common";
import {
  type SkillHybridSearchResponse,
  searchSkillsHybrid,
} from "@/lib/pi-extension/skill-hybrid-search";
import type { EmbeddingEngine } from "@/lib/retrieval/embeddings";

const PROMPT_SKILL_HINT_LIMIT = 5;
const PROMPT_SKILL_HINT_MIN_SCORE = 0.3;
const PROMPT_SKILL_HINT_TOP_RATIO = 0.85;

export async function loadSkillsGuidance(input: {
  skillsRoot: string;
  surface?: string | null;
  hintQuery?: string | undefined;
  embeddingEngine?: EmbeddingEngine | null | undefined;
}): Promise<string> {
  return [
    "Skill storage:",
    "- core and surface skills may have builtin and custom layers",
    "- custom skills override builtins with the same name",
    "- skill reads and searches use the effective skill set for the current surface",
    '- skill writes default to the current surface when a surface context is present; pass scope: "core" only for truly global instructions',
    "",
    "Skill use:",
    "- use skill_search to find reusable instructions related to a task",
    "- use skill_read to load the full text of a matching skill before relying on it",
    "- use skill_list only when broad orientation is needed",
    "- use skill_write or skill_delete to maintain custom skills when Sandi should preserve or change durable behavior",
    "- skill names are logical references, not filesystem paths",
    "- do not claim a skill shaped your answer unless it came from this section or a skill tool result",
    ...formatSkillHintSection(await searchSkillHints(input)),
  ].join("\n");
}

async function searchSkillHints(input: {
  skillsRoot: string;
  surface?: string | null;
  hintQuery?: string | undefined;
  embeddingEngine?: EmbeddingEngine | null | undefined;
}): Promise<SkillHybridSearchResponse | null> {
  const query = input.hintQuery?.trim();
  if (!query) return null;
  if (shouldSkipPromptSkillHints(query)) return null;

  const response = await searchSkillsHybrid({
    root: input.skillsRoot,
    surface: input.surface ?? null,
    query,
    contentMode: "passages",
    lexicalMode: "boost",
    maxResults: PROMPT_SKILL_HINT_LIMIT,
    maxSnippets: 1,
    minScore: 0.24,
    minEmbeddingScore: 0.2,
    supportingScoreWeight: 0,
    embeddingEngine: input.embeddingEngine,
  });
  const results = filterPromptSkillHints(response.results);
  return results.length > 0 ? { ...response, results } : null;
}

function formatSkillHintSection(
  response: Awaited<ReturnType<typeof searchSkillHints>>,
): string[] {
  if (!response || response.results.length === 0) return [];
  return [
    "",
    "Potentially relevant skills to the prompt:",
    ...response.results.flatMap((result) => {
      const lines = [
        `- ${result.name} (${formatSkillSource(result.source)}): ${result.description ?? "No description."}`,
        `  match: ${formatHintSignals(result)}`,
      ];
      const snippet = result.snippets[0];
      if (snippet) lines.push(`  why: ${snippet}`);
      return lines;
    }),
    "These are hints only. Read a listed skill if it actually applies; ignore false positives.",
  ];
}

function shouldSkipPromptSkillHints(query: string): boolean {
  return (
    isCasualAcknowledgement(query) ||
    isPreferenceOrNoteOnly(query) ||
    isGenericMemoryRecall(query) ||
    isGenericHowQuestion(query)
  );
}

function filterPromptSkillHints(
  results: SkillHybridSearchResponse["results"],
): SkillHybridSearchResponse["results"] {
  const topScore = results[0]?.score ?? 0;
  if (topScore === 0) return [];
  return results
    .filter(
      (result) =>
        result.score >=
        Math.max(
          PROMPT_SKILL_HINT_MIN_SCORE,
          topScore * PROMPT_SKILL_HINT_TOP_RATIO,
        ),
    )
    .slice(0, PROMPT_SKILL_HINT_LIMIT);
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

function isPreferenceOrNoteOnly(query: string): boolean {
  const normalized = normalizeQuery(query);
  if (normalized.startsWith("note:")) return true;
  const hasPreferenceSignal =
    normalized.startsWith("i usually prefer ") ||
    normalized.startsWith("i prefer ") ||
    normalized.startsWith("mildly prefer ") ||
    normalized.startsWith("i mostly trust ") ||
    normalized.includes(" i usually prefer ") ||
    normalized.includes(" i prefer ") ||
    normalized.includes(" mildly prefer ") ||
    normalized.includes(" i mostly trust ") ||
    normalized.startsWith("i'm ") ||
    normalized.startsWith("i am ");
  if (!hasPreferenceSignal) return false;
  return !hasExplicitRequestIntent(normalized);
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
    /\b(food|restaurant|doordash|google maps|bdo|black desert|game)\b/u,
    /\b(skill|code|repo|branch|pull request|pr|deploy|runtime|prompt|context)\b/u,
    /\b(image|generate|draw|look up|search|research|tweet|docs|http)\b/u,
  ]);
}

function isGenericHowQuestion(query: string): boolean {
  const normalized = normalizeQuery(query);
  if (
    !(
      normalized.startsWith("how does this work") ||
      normalized.startsWith("how does it work") ||
      normalized.startsWith("how do conversations") ||
      normalized.startsWith("how are conversations")
    )
  ) {
    return false;
  }
  return !hasAnyRegex(normalized, [
    /\b(todo|to do|task|remind|reminder|skill|memory|food|restaurant|doordash|google maps|bdo|black desert|game|image|generate|pull request|pr|code|repo|branch|deploy|runtime|prompt|context|thread|channel|forum)\b/u,
    /https?:\/\//u,
  ]);
}

function hasActionIntent(normalized: string): boolean {
  return hasAnyRegex(normalized, [
    /\b(can you|could you|please|let's|lets|i want|should we|what would|how do|how does)\b/u,
    /\b(make|create|add|update|change|fix|implement|look up|search|research|read about|generate|open|write|run|test|debug|deploy|restart|explain|compare|find|fetch|calculate|plan|review|format|remind|schedule|investigate)\b/u,
  ]);
}

function hasExplicitRequestIntent(normalized: string): boolean {
  return hasAnyRegex(normalized, [
    /\b(can you|could you|please|let's|lets|i want|should we|what would|how do|how does)\b/u,
    /\b(change|update|fix|implement|look up|search|research|read about|generate|open|write|test|debug|deploy|restart|explain|compare|find|fetch|calculate|plan|review|format|remind|schedule|investigate)\b/u,
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
  result: SkillHybridSearchResponse["results"][number],
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

import {
  formatSkillSource,
  listSkills,
  type SkillMetadata,
} from "@/lib/pi-extension/skill-common";

const MAX_SKILL_HINTS = 3;
const MIN_SKILL_HINT_SCORE = 3;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const SKILL_HINT_ALIASES = new Map<string, readonly string[]>([
  ["food-finder", ["eat", "food", "restaurant", "takeout", "dinner", "lunch"]],
  ["pull-request", ["pr", "prs", "pull", "request", "review", "merge"]],
  ["reminders", ["remind", "reminder", "ping", "tomorrow", "snooze"]],
  [
    "self-development",
    [
      "customize",
      "modify",
      "change",
      "runtime",
      "self",
      "repo",
      "code",
      "data",
    ],
  ],
  [
    "temporal-continuity",
    ["schedule", "scheduled", "recurring", "later", "tomorrow"],
  ],
  ["todo-list", ["todo", "task", "tasks", "done", "checklist"]],
  [
    "web-research",
    [
      "cite",
      "citation",
      "current",
      "fact",
      "facts",
      "latest",
      "news",
      "search",
      "source",
      "sources",
      "verify",
      "web",
    ],
  ],
]);

const STOPWORDS = new Set([
  "a",
  "about",
  "all",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "could",
  "do",
  "for",
  "from",
  "have",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "should",
  "that",
  "the",
  "this",
  "to",
  "use",
  "we",
  "what",
  "when",
  "with",
  "would",
  "you",
  "your",
]);

type SkillHintDocument = {
  skill: SkillMetadata;
  length: number;
  terms: Map<string, number>;
};

export async function loadSkillsGuidance(input: {
  skillsRoot: string;
  surface?: string | null;
  hintQuery?: string | undefined;
}): Promise<string> {
  const skills = await listSkills({
    root: input.skillsRoot,
    surface: input.surface ?? null,
  });
  return [
    "Skill storage:",
    "- data/skills/core/builtin: checked-in global builtin skills",
    "- data/skills/core/custom: Sandi-written global skills and overrides",
    "- data/skills/surfaces/<surface>/builtin: checked-in surface skills",
    "- data/skills/surfaces/<surface>/custom: Sandi-written surface skills and overrides",
    "- effective precedence is surface custom, surface builtin, core custom, core builtin",
    "- skill reads and searches use the effective skill set for the current surface",
    '- skill writes default to the current surface when a surface context is present; pass scope: "core" only for truly global instructions',
    "- prefer custom skills for runtime self-extension; editing builtin skills is source maintenance for checked-in starter behavior",
    "",
    "Available effective skill index:",
    ...formatSkillIndex(skills),
    ...formatSkillHintSection(skills, input.hintQuery),
    "",
    "Use skill_search to find reusable instructions related to a task, skill_read to load a matching skill, skill_list to inspect the index, and skill_write or skill_delete to maintain custom skills. Prefer runtime custom skills when Sandi should preserve or change her own durable behavior. Do not claim a skill shaped your answer unless it came from this section or a skill tool result.",
  ].join("\n");
}

function formatSkillIndex(skills: SkillMetadata[]): string[] {
  if (skills.length === 0) return ["- none"];
  return skills.map((skill) => {
    const description = skill.description ?? "No description.";
    return `- ${skill.name} (${formatSkillSource(skill.source)}): ${description}`;
  });
}

function formatSkillHintSection(
  skills: SkillMetadata[],
  query: string | undefined,
): string[] {
  const candidates = rankedSkillHints(skills, query);
  if (candidates.length === 0) return [];
  return [
    "",
    "Possible relevant skills for this turn:",
    ...candidates.map(
      (candidate) =>
        `- ${candidate.skill.name}: ${candidate.skill.description ?? "No description."}`,
    ),
    "Hint only: read a listed skill if it actually applies; ignore false positives.",
  ];
}

export function rankedSkillHints(
  skills: SkillMetadata[],
  query: string | undefined,
): Array<{ skill: SkillMetadata; score: number }> {
  const queryTokens = tokenizeSkillText(query ?? "");
  if (queryTokens.length === 0 || skills.length === 0) return [];

  const documents = skills.map(skillHintDocument);
  const averageLength = averageDocumentLength(documents);
  const documentFrequency = documentFrequencies(documents);

  return documents
    .map((document) => ({
      skill: document.skill,
      score: bm25Score({
        document,
        queryTokens,
        documentFrequency,
        totalDocuments: documents.length,
        averageLength,
      }),
    }))
    .filter((candidate) => candidate.score >= MIN_SKILL_HINT_SCORE)
    .sort(compareSkillHints)
    .slice(0, MAX_SKILL_HINTS);
}

function skillHintDocument(skill: SkillMetadata): SkillHintDocument {
  const weightedTokens = [
    ...repeatTokens(tokenizeSkillText(skill.name), 3),
    ...repeatTokens(
      (SKILL_HINT_ALIASES.get(skill.name) ?? []).flatMap(normalizeToken),
      3,
    ),
    ...tokenizeSkillText(skill.description ?? ""),
  ];
  return {
    skill,
    length: weightedTokens.length,
    terms: termFrequencies(weightedTokens),
  };
}

function repeatTokens(tokens: string[], times: number): string[] {
  return Array.from({ length: times }, () => tokens).flat();
}

function termFrequencies(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

function documentFrequencies(
  documents: SkillHintDocument[],
): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const document of documents) {
    for (const token of document.terms.keys()) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }
  return frequencies;
}

function averageDocumentLength(documents: SkillHintDocument[]): number {
  const totalLength = documents.reduce(
    (total, document) => total + document.length,
    0,
  );
  return Math.max(1, totalLength / documents.length);
}

function bm25Score(input: {
  document: SkillHintDocument;
  queryTokens: string[];
  documentFrequency: Map<string, number>;
  totalDocuments: number;
  averageLength: number;
}): number {
  const uniqueQueryTokens = new Set(input.queryTokens);
  let score = 0;
  for (const token of uniqueQueryTokens) {
    const termFrequency = input.document.terms.get(token) ?? 0;
    if (termFrequency === 0) continue;

    const documentFrequency = input.documentFrequency.get(token) ?? 0;
    const idf = Math.log(
      1 +
        (input.totalDocuments - documentFrequency + 0.5) /
          (documentFrequency + 0.5),
    );
    const lengthFactor =
      BM25_K1 *
      (1 - BM25_B + BM25_B * (input.document.length / input.averageLength));
    score +=
      idf * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + lengthFactor));
  }
  return score;
}

function compareSkillHints(
  left: { skill: SkillMetadata; score: number },
  right: { skill: SkillMetadata; score: number },
): number {
  const byScore = right.score - left.score;
  if (byScore !== 0) return byScore;
  return left.skill.name.localeCompare(right.skill.name);
}

function tokenizeSkillText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .flatMap(normalizeToken)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function normalizeToken(token: string): string[] {
  if (token === "pr" || token === "prs") return ["pr", "pull", "request"];
  if (token.length > 3 && token.endsWith("s")) return [token.slice(0, -1)];
  return [token];
}

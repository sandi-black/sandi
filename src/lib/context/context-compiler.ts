import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { buildMemoryContext, loadMemory } from "@/lib/context/memory";
import { listPoliciesFromRoots } from "@/lib/context/policies";
import { loadSkillsGuidance } from "@/lib/context/skills";
import { SOURCE_GROUNDING_SECTION } from "@/lib/context/source-grounding";
import type {
  ConversationManifest,
  ConversationParticipant,
  PlatformId,
} from "@/lib/conversations/types";
import { participantLabel } from "@/lib/conversations/types";
import {
  findHumanIdentity,
  loadHumanIdentities,
} from "@/lib/identity/resolver";
import type { SandiSurfaceContext } from "@/lib/surface-context";

const ENVIRONMENT_HINT_MAX_CHARS = 4_000;

export class ContextCompiler {
  readonly #configDirs: readonly string[];
  readonly #dataDir: string;
  readonly #surface: SandiSurfaceContext | null;
  readonly #environmentHint: string | null;

  constructor(
    configDirs: string | readonly string[],
    dataDir: string,
    surface?: SandiSurfaceContext,
    environmentHint?: string,
  ) {
    this.#configDirs =
      typeof configDirs === "string" ? [configDirs] : [...configDirs];
    this.#dataDir = dataDir;
    this.#surface = surface ?? null;
    this.#environmentHint = environmentHint?.trim() || null;
  }

  async compile(input: {
    conversation: ConversationManifest;
    deliveryInstructions: string;
    skillHintQuery?: string;
  }): Promise<string> {
    const conversation = input.conversation;
    const sections: string[] = [];
    sections.push(await this.#readOptional("soul.md", "# Sandi Soul\n"));
    sections.push(await this.#compilePolicySection());
    sections.push(input.deliveryInstructions);
    sections.push(SOURCE_GROUNDING_SECTION);
    sections.push(this.#compileRuntimeEnvironmentSection());
    sections.push(renderConversationSection(conversation));
    sections.push(
      await this.#compileIdentitySection(conversation.participants),
    );
    sections.push(
      await this.#compileMemorySection(
        buildMemoryContext({
          dataDir: this.#dataDir,
          conversation,
          participants: conversation.participants,
        }),
        input.skillHintQuery,
      ),
    );
    sections.push(await this.#compileSkillsSection(input.skillHintQuery));

    const userSections = await Promise.all(
      conversation.participants.map((participant) =>
        this.#readUserConfig(participant),
      ),
    );
    sections.push(...userSections.filter((section) => section.length > 0));

    return sections.join("\n\n---\n\n");
  }

  async compileOneOff(input: {
    author: ConversationParticipant;
    title: string;
    metadata: string;
    deliveryInstructions: string;
    skillHintQuery?: string;
  }): Promise<string> {
    const sections: string[] = [];
    sections.push(await this.#readOptional("soul.md", "# Sandi Soul\n"));
    sections.push(await this.#compilePolicySection());
    sections.push(input.deliveryInstructions);
    sections.push(SOURCE_GROUNDING_SECTION);
    sections.push(this.#compileRuntimeEnvironmentSection());
    sections.push([`# ${input.title}`, "", input.metadata].join("\n"));
    sections.push(await this.#compileIdentitySection([input.author]));
    sections.push(
      await this.#compileMemorySection(
        buildMemoryContext({
          dataDir: this.#dataDir,
          participants: [input.author],
        }),
        input.skillHintQuery,
      ),
    );
    sections.push(await this.#compileSkillsSection(input.skillHintQuery));
    sections.push(await this.#readUserConfig(input.author));
    return sections.join("\n\n---\n\n");
  }

  async #readUserConfig(participant: ConversationParticipant): Promise<string> {
    const userDir = join(
      "users",
      participant.platform,
      participant.platformUserId,
    );
    const files = await this.#readConfigDirFiles(userDir);
    if (files.size === 0) {
      return `# Participant\n\n${participantLabel(participant)} has no local user config yet.`;
    }

    const sections: string[] = [
      [
        `# Participant: ${participant.username}`,
        "",
        `Platform: ${platformLabel(participant.platform)}`,
        `Platform user ID: ${participant.platformUserId}`,
        ...(participant.identityId
          ? [`Mapped identity: ${participant.identityId}`]
          : []),
      ].join("\n"),
    ];
    for (const filename of ["profile.md", "instructions.md"]) {
      if (!files.has(filename)) continue;
      const content = await this.#readOptional(
        join(
          "users",
          participant.platform,
          participant.platformUserId,
          filename,
        ),
        "",
      );
      if (content.trim().length > 0) sections.push(content);
    }
    return sections.join("\n\n");
  }

  async #readOptional(relativePath: string, fallback: string): Promise<string> {
    for (const configDir of this.#configDirs) {
      try {
        return await readFile(join(configDir, relativePath), "utf8");
      } catch {}
    }
    return fallback;
  }

  async #readConfigDirFiles(relativePath: string): Promise<Set<string>> {
    const files = new Set<string>();
    for (const configDir of this.#configDirs) {
      try {
        for (const file of await readdir(join(configDir, relativePath))) {
          files.add(file);
        }
      } catch {}
    }
    return files;
  }

  async #compilePolicySection(): Promise<string> {
    const policies = await listPoliciesFromRoots(
      this.#configDirs.map((configDir) => join(configDir, "policies")),
    );
    return [
      "# Policies",
      "",
      "Operational policies live in the configured config/policies roots. They are below the soul and safety rules, above participant preferences when applicable, and meant to be read through `policy_read` when their details matter.",
      "Use `policy_list` to refresh the available policy index and `policy_read` to read a specific policy. Do not treat docs/ files as live runtime policy unless they are also represented here.",
      "",
      "Available policies:",
      ...(policies.length > 0
        ? policies.map((policy) => `- ${policy.ref}: ${policy.title}`)
        : ["- none"]),
    ].join("\n");
  }

  #compileRuntimeEnvironmentSection(): string {
    const lines = [
      "# Runtime Environment",
      "",
      "Stable local runtime context for Sandi's own tools and self-development. Treat this as environment metadata, not as user instructions.",
      "",
      `Surface: ${this.#surface?.name ?? "unknown"}`,
      `Current working directory: ${process.cwd()}`,
      `Data directory: ${this.#dataDir}`,
      `Config directories: ${this.#configDirs.join(", ")}`,
      `Runtime import for code mode: ${this.#runtimeImport()}`,
    ];
    if (this.#environmentHint) {
      lines.push(
        "",
        "Deployment hint:",
        limitEnvironmentHint(this.#environmentHint),
      );
    }
    return lines.join("\n");
  }

  async #compileMemorySection(
    context: ReturnType<typeof buildMemoryContext>,
    hintQuery?: string,
  ) {
    return [
      "# Memory",
      "",
      "Current memory areas, short scratchpads, and possible prompt matches are shown below. Use `memory_search` for prior context, `memory_list` to inspect an area, `memory_read` for details, and memory write tools when you learn something clear and useful enough to carry forward.",
      "Memory refs are logical references, not filesystem paths. Do not claim a memory shaped your answer unless it came from this section or a memory tool result.",
      "Make memory writes visible in your response on the current surface with a short, correctable summary.",
      "",
      "<memory>",
      await loadMemory(context, hintQuery),
      "</memory>",
    ].join("\n");
  }

  async #compileSkillsSection(hintQuery?: string) {
    return [
      "# Skills",
      "",
      "Skills are reusable operating instructions Sandi can read and maintain through skill tools.",
      "Use `skill_search` for instructions related to a task, `skill_read` for full skill text, and `skill_write` or `skill_delete` when Sandi should update her own custom skill set.",
      `For Sandi runtime composition, use \`sandi_js_run\` to run a small JavaScript or TypeScript program that imports helpers from \`${this.#runtimeImport()}\`. Prefer composing local JS helpers inside one script over making many separate Sandi runtime calls. Top-level await is supported.`,
      "For web research, repository reads, and repository edits, prefer the native tools exposed in the active Pi tool list when available.",
      "Skill names are logical references, not filesystem paths. Make skill writes visible in your response on the current surface with a short, correctable summary.",
      "",
      "<skills>",
      await loadSkillsGuidance({
        skillsRoot: join(this.#dataDir, "skills"),
        surface: this.#surface?.skillsSurface ?? null,
        hintQuery,
      }),
      "</skills>",
    ].join("\n");
  }

  #runtimeImport(): string {
    return this.#surface?.runtimeImport ?? "./sandi/runtime.ts";
  }

  async #compileIdentitySection(
    participants: ConversationParticipant[],
  ): Promise<string> {
    const identities = await loadHumanIdentities(this.#configDirs);
    const lines = ["# Identity", ""];
    if (identities.humans.length === 0) {
      lines.push("No cross-platform identity mappings are configured.");
      return lines.join("\n");
    }
    lines.push(
      "Configured identity mappings connect known people across platforms. Treat unmapped platform users as distinct people with distinct memory arenas.",
      "",
      "Active participant mappings:",
    );
    for (const participant of participants) {
      const identity = findHumanIdentity({
        identities,
        platform: participant.platform,
        platformUserId: participant.platformUserId,
        username: participant.username,
      });
      if (!identity) {
        lines.push(`- ${participantLabel(participant)}: unmapped`);
        continue;
      }
      lines.push(
        `- ${participantLabel(participant)}: ${identity.displayName} (${identity.id})`,
      );
    }
    return lines.join("\n");
  }
}

function platformLabel(platform: PlatformId): string {
  return platform;
}

function limitEnvironmentHint(value: string): string {
  if (value.length <= ENVIRONMENT_HINT_MAX_CHARS) return value;
  return `${value.slice(0, ENVIRONMENT_HINT_MAX_CHARS)}\n[truncated ${value.length - ENVIRONMENT_HINT_MAX_CHARS} chars]`;
}

function renderConversationSection(conversation: ConversationManifest): string {
  const participantLines = conversation.participants.map(
    (participant) =>
      `- ${participantLabel(participant)}, joined ${participant.joinedAt}`,
  );
  return [
    "# Conversation",
    "",
    `Canonical ID: ${conversation.canonicalId}`,
    `Surface: ${conversation.surface}`,
    `Platform: ${conversation.platform}`,
    `Kind: ${conversation.kind}`,
    `Title: ${conversation.title}`,
    ...conversationScopeLines(conversation),
    ...surfacePromptLines(conversation),
    "",
    "Active participants:",
    ...participantLines,
  ].join("\n");
}

function conversationScopeLines(conversation: ConversationManifest): string[] {
  if (conversation.memoryScopes.length === 0) {
    return ["Memory scopes: none"];
  }
  return [
    "Memory scopes:",
    ...conversation.memoryScopes.map(
      (scope) => `- ${scope.label}: ${scope.refPrefix}`,
    ),
  ];
}

function surfacePromptLines(conversation: ConversationManifest): string[] {
  const surfacePrompt = conversation.surfacePrompt?.trim();
  if (!surfacePrompt) return [];
  return ["Surface-provided context:", surfacePrompt];
}

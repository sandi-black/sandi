import { Cron } from "croner";
import {
  type AnyThreadChannel,
  type ChatInputCommandInteraction,
  Client,
  Events,
  type ForumChannel,
  GatewayIntentBits,
  type GuildMember,
  type Interaction,
  type Message,
  type MessageCreateOptions,
  type MessageReaction,
  type PartialMessageReaction,
  Partials,
  type PartialUser,
  ThreadAutoArchiveDuration,
  type User,
} from "discord.js";

import type { ContextCompiler } from "@/lib/context/context-compiler";
import { buildMemoryContext, type MemoryContext } from "@/lib/context/memory";
import type { ConversationStore } from "@/lib/conversations/store";
import type {
  ConversationManifest,
  ConversationParticipant,
} from "@/lib/conversations/types";
import {
  findHumanIdentity,
  loadHumanIdentities,
} from "@/lib/identity/resolver";
import type { HumanIdentityConfig } from "@/lib/identity/types";
import { createLogger } from "@/lib/logging";
import {
  defaultApiPairingsPath,
  PAIRING_TTL_MS,
} from "@/lib/pairing/pairing-store";
import type {
  DesktopHands,
  DesktopHandsLease,
} from "@/lib/provider/desktop-hands";
import { leaseDesktopHands } from "@/lib/provider/desktop-hands";
import type { PiAccountRoutingRequest } from "@/lib/provider/pi-account-routing";
import {
  type ModelProviderClient,
  ProviderTurnError,
  type ProviderTurnResponse,
} from "@/lib/provider/pi-cli-client";
import { ThreadQueue } from "@/lib/turns/turn-queue";
import { issueDeviceCode } from "@/surfaces/discord/bot/device-auth";
import {
  appendIgnoredConversationChannel,
  loadIgnoredConversationChannels,
  removeIgnoredConversationChannel,
} from "@/surfaces/discord/bot/ignored-channels";
import {
  PASSIVE_REPLY_GATE_INSTRUCTIONS,
  PASSIVE_REPLY_GATE_THINKING,
  PASSIVE_REPLY_GATE_TIMEOUT_MS,
  type PassiveReplyGateContextMessage,
  parsePassiveReplyGateDecision,
  passiveReplyGateRequestInput,
} from "@/surfaces/discord/bot/passive-reply-gate";
import { ReactionDigestStore } from "@/surfaces/discord/bot/reaction-digest";
import { ReminderManager } from "@/surfaces/discord/bot/reminders";
import {
  botStatusMessage,
  postStartupStatus,
} from "@/surfaces/discord/bot/startup-status";
import {
  MENTION_THREAD_PLACEHOLDER_TITLE,
  MENTION_THREAD_TITLE_THINKING,
  MENTION_THREAD_TITLE_TIMEOUT_MS,
  normalizeGeneratedThreadTitle,
  THREAD_TITLE_INSTRUCTIONS,
  threadTitleRequestInput,
} from "@/surfaces/discord/bot/thread-title";
import { TodoListManager } from "@/surfaces/discord/bot/todo-list";
import type { DiscordAppConfig } from "@/surfaces/discord/config";
import {
  buildDiscordChannelManifest,
  buildDiscordThreadManifest,
  canonicalDiscordChannelId,
  canonicalDiscordThreadId,
  type DiscordThreadConversationSource,
  discordConversationStorageId,
  isDiscordThreadConversation,
  withDiscordSurfacePrompt,
} from "@/surfaces/discord/discord/conversations";
import { DISCORD_DELIVERY_INSTRUCTIONS } from "@/surfaces/discord/discord/delivery-instructions";
import { findSandiForum } from "@/surfaces/discord/discord/forum";
import { chunkDiscordMessage } from "@/surfaces/discord/discord/messages";
import type {
  EventTarget,
  SandiEvent,
} from "@/surfaces/discord/events/schemas";
import { listEvents, type StoredEvent } from "@/surfaces/discord/events/store";
import {
  type EventTrigger,
  EventWatcher,
} from "@/surfaces/discord/events/watcher";
import { DISCORD_SURFACE_CONTEXT } from "@/surfaces/discord/runtime/context";

const log = createLogger("bot");
const FAILURE_NOTICE_COOLDOWN_MS = 60_000;
const HELP_MESSAGE = [
  "**Sandi commands**",
  "`/sandi help`: show this command guide.",
  "`/sandi stop`: ask the current Sandi turn in this conversation to stop.",
  "`/sandi ignore`: stop the current turn and have Sandi ignore this channel or thread unless she is @-mentioned.",
  "`/sandi listen`: undo `/sandi ignore` so Sandi responds in this channel or thread again.",
  "`/sandi todo`: create and pin an interactive todo list in this channel.",
  "`/sandi status`: show runtime status, uptime/memory health, queue state, git revision, token usage, provider limits, and current conversation context size.",
  "`/sandi auth`: get a one-time code to connect a desktop client to Sandi (privately, just to you).",
  "`/sandi events list`: list scheduled events for this conversation.",
  "`/sandi events list scope: All events`: list every scheduled event Sandi can see.",
  "`/sandi reminders list`: list interactive human reminders for this conversation.",
  "`/sandi reminders list scope: All reminders`: list every interactive reminder Sandi can see.",
  "",
  "Sandi reads the channels she can see and chimes in when a message seems meant for her. Mention her or reply to one of her messages to be sure she answers; when she replies in a busy channel she opens a thread to keep things tidy.",
].join("\n");
const MAX_EVENTS_DISPLAYED = 10;
const MAX_INTERACTION_RESPONSE_CHARS = 2_000;
const TYPING_TIMEOUT_MS = 3_000;
const TYPING_INTERVAL_MS = 9_000;
const TYPING_FALLBACK_COOLDOWN_MS = 15_000;
const ACTIVITY_FALLBACK_EMOJI = "👀";
const DEFAULT_MENTION_THREAD_AUTO_ARCHIVE = ThreadAutoArchiveDuration.OneDay;
const TODO_CHANNEL_PREFIXES = ["todo-", "tasks-"];
const RECENT_THREAD_CONTEXT_FETCH_LIMIT = 20;
const RECENT_THREAD_CONTEXT_DISPLAY_LIMIT = 8;
const RECENT_THREAD_MESSAGE_MAX_LENGTH = 260;
const PASSIVE_GATE_CONTEXT_FETCH_LIMIT = 12;
const PASSIVE_GATE_CONTEXT_DISPLAY_LIMIT = 6;
const MAX_TYPING_COOLDOWNS = 512;
const MAX_FAILURE_NOTICE_COOLDOWNS = 512;
const TODO_CHANNEL_SURFACE_PROMPT = [
  "This is a dedicated Discord todo channel.",
  "Ordinary human messages here are todo instructions, not conversation, even when Sandi is not mentioned.",
  'For clear add, update, complete, remove, reminder, or recurrence instructions: use `import { todo, discord } from "./sandi/runtime.ts"` in code mode to update the canonical todo list, then delete the handled human message with `discord.deleteMessage()` or `discord.deleteMessage({ messageId })`. Do not send a conversational reply after successful handling.',
  "If a message is ambiguous, reply to that message with a concise clarification question and leave the message visible. Once the ambiguity is cleared up, take the todo action and delete the original ambiguous message plus the clarification exchange when practical so the channel stays clean.",
  "Keep the visible channel as todo/list/reminder state only. Use Pacific time for relative household todo times unless the user explicitly says otherwise.",
].join("\n");
const typingCooldowns = new Map<string, number>();
const typingInFlight = new Set<string>();

export type SandiBotDependencies = {
  config: DiscordAppConfig;
  conversations: ConversationStore;
  contextCompiler: ContextCompiler;
  provider: ModelProviderClient;
  // When the host runs the api surface alongside Discord, it injects the shared
  // desktop-hands capability so a Discord turn from a human whose desktop is
  // linked can run file and shell tools on that desktop. Absent in a standalone
  // Discord process, where no desktop links exist to reach.
  desktopHands?: DesktopHands;
};

type DiscordToolContext = {
  platform: "discord";
  guildId?: string;
  channelId: string;
  parentChannelId?: string;
  threadId?: string;
  messageId: string;
  author?: {
    discordUserId: string;
    username?: string;
    displayName?: string;
    identityId?: string;
  };
};

type FailureNoticeChannel = {
  send(options: MessageCreateOptions): Promise<unknown>;
};

type ConversationDiscordChannel = FailureNoticeChannel & {
  id: string;
  guildId: string;
  name: string;
  parentId: string | null;
  sendTyping(): Promise<void>;
  isThread?: () => boolean;
};

type RunTurnInput = {
  channel: ConversationDiscordChannel;
  conversation: ConversationManifest;
  author: ConversationParticipant;
  messageId: string;
  input: string;
  metadata: string;
  toolContext: DiscordToolContext;
  replyToMessageId?: string;
  signal?: AbortSignal;
  suppressFinalResponse?: boolean;
  reactOnTypingFailure?: boolean;
  failureReplyToMessageId?: string | false;
};

export class SandiBot {
  readonly #client: Client;
  readonly #config: DiscordAppConfig;
  readonly #conversations: ConversationStore;
  readonly #contextCompiler: ContextCompiler;
  readonly #provider: ModelProviderClient;
  readonly #desktopHands: DesktopHands | undefined;
  readonly #events: EventWatcher;
  readonly #reminders: ReminderManager;
  readonly #reactions: ReactionDigestStore;
  readonly #todoList: TodoListManager;
  readonly #queue = new ThreadQueue();
  #ignoredChannels: Promise<Set<string>> | undefined;
  readonly #failureNotices = new Map<string, number>();
  #identities: Promise<HumanIdentityConfig> | undefined;
  #forum: ForumChannel | undefined;

  constructor(deps: SandiBotDependencies) {
    this.#config = deps.config;
    this.#conversations = deps.conversations;
    this.#contextCompiler = deps.contextCompiler;
    this.#provider = deps.provider;
    this.#desktopHands = deps.desktopHands;
    this.#events = new EventWatcher(
      this.#config.paths.eventsRoot,
      (trigger) => {
        void this.#enqueueEventTurn(trigger);
      },
    );
    this.#client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
      partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction,
        Partials.User,
      ],
    });
    this.#todoList = new TodoListManager({
      client: this.#client,
      dataDir: this.#config.paths.dataDir,
      remindersRoot: this.#config.paths.remindersRoot,
    });
    this.#reminders = new ReminderManager({
      client: this.#client,
      remindersRoot: this.#config.paths.remindersRoot,
      onReminderDone: async ({ id, reminder }) => {
        if (reminder.recurrence) return;
        await this.#todoList.removeCompletedOneTimeReminder(id);
      },
    });
    this.#reactions = new ReactionDigestStore(this.#config.paths.dataDir);
  }

  async start(): Promise<void> {
    this.#client.once(Events.ClientReady, async (client) => {
      log.info("discord client ready", {
        user: client.user.tag,
      });
      this.#forum = await findSandiForum(this.#client, this.#config.discord);
      log.info("sandi forum channel ready", {
        channelId: this.#forum.id,
        name: this.#forum.name,
      });
      await postStartupStatus(this.#client, this.#config.discord);
      await this.#events.start();
      await this.#reminders.start();
    });

    this.#client.on(Events.Debug, (message) => {
      if (message.includes("Provided token")) return;
      if (
        !message.includes("Heartbeat") &&
        !message.includes("Sending a heartbeat")
      ) {
        log.info("discord client debug", { message });
      }
    });

    this.#client.on(Events.Warn, (message) => {
      log.warn("discord client warning", { message });
    });

    this.#client.on(Events.Error, (error) => {
      log.error("discord client error", { error: error.message });
    });

    this.#client.on(Events.ShardDisconnect, (event, shardId) => {
      log.warn("discord shard disconnected", {
        shardId,
        code: event.code,
        reason: event.reason,
      });
    });

    this.#client.on(Events.ShardReady, (shardId, unavailableGuilds) => {
      log.info("discord shard ready", {
        shardId,
        unavailableGuilds: unavailableGuilds?.size ?? 0,
      });
    });

    this.#client.on(Events.Raw, (packet) => {
      if (packet.t === "MESSAGE_CREATE" || packet.t === "INTERACTION_CREATE") {
        log.info("discord raw dispatch", { type: packet.t });
      }
    });

    this.#client.on(Events.MessageCreate, (message) => {
      void this.#handleMessage(message);
    });

    this.#client.on(Events.MessageReactionAdd, (reaction, user) => {
      void this.#handleMessageReaction("added", reaction, user);
    });

    this.#client.on(Events.MessageReactionRemove, (reaction, user) => {
      void this.#handleMessageReaction("removed", reaction, user);
    });

    this.#client.on(Events.InteractionCreate, (interaction) => {
      // The dispatch is fire-and-forget from the gateway event. Catch here so a
      // rejection from any handler (filesystem, identity load, or a Discord
      // reply) is logged and surfaced to the user instead of escaping as an
      // unhandled rejection.
      void this.#handleInteraction(interaction).catch((error: unknown) => {
        log.error("failed to handle Discord interaction", {
          error: error instanceof Error ? error.message : String(error),
        });
        void respondToFailedInteraction(interaction);
      });
    });

    await this.#client.login(this.#config.discord.token);
  }

  stop(): void {
    log.info("stopping Discord bot");
    this.#events.stop();
    this.#reminders.stop();
    this.#client.removeAllListeners();
    this.#client.destroy();
  }

  async #handleMessage(message: Message): Promise<void> {
    log.info("discord message received", {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId ?? "dm",
      authorId: message.author.id,
      authorBot: message.author.bot,
      contentLength: message.content.length,
      mentionedBot: this.#isBotMentioned(message),
      channelType: message.channel.type,
    });
    if (message.author.bot) return;
    const todoChannel = asTodoChannel(message.channel);
    if (todoChannel) {
      log.info("enqueueing todo channel turn", {
        messageId: message.id,
        channelId: todoChannel.id,
      });
      const author = await this.#participantFromMessage(message);
      await this.#enqueueChannelTurn({
        channel: todoChannel,
        author,
        messageId: message.id,
        input:
          message.content.trim() ||
          "A todo-channel message arrived without text content.",
        metadata: await messageMetadata(message),
        toolContext: toolContextFromMessage(message, author),
        title: todoChannel.name,
        suppressFinalResponse: true,
      });
      return;
    }

    await this.#todoList.maybeCapture(message);

    // Ignore list: an ignored channel or thread (set via `/sandi ignore`) is
    // skipped entirely unless someone explicitly @-mentions Sandi. Replies and
    // the passive gate do not wake her there. This intentionally also gates
    // Sandi-managed threads so an ignored thread truly goes quiet.
    const mentioned = this.#isBotMentioned(message);
    if (!mentioned && (await this.#isIgnoredChannel(message))) {
      log.info("skipping message in ignored channel or thread", {
        messageId: message.id,
        channelId: message.channelId,
      });
      return;
    }

    const thread = asThread(message.channel);
    if (thread && (await this.#isManagedThread(thread))) {
      log.info("enqueueing sandi thread turn", {
        messageId: message.id,
        threadId: thread.id,
        parentId: thread.parentId,
      });
      const strippedContent = stripBotMention(
        message.content,
        this.#client.user?.id,
      );
      const author = await this.#participantFromMessage(message);
      await this.#enqueueThreadTurn({
        thread,
        author,
        messageId: message.id,
        input: strippedContent,
        metadata: await messageMetadata(message),
        toolContext: toolContextFromMessage(message, author),
        title: thread.name,
        replyToMessageId: message.id,
      });
      return;
    }

    // Sandi passively reads every other message. An explicit mention or a reply
    // to one of her own messages always earns a response; anything else goes
    // through a cheap gate that decides whether the message was meant for her.
    const mustRespond = mentioned || (await this.#isReplyToSandi(message));
    if (!mustRespond) {
      if (!(await this.#shouldRespondToPassiveMessage(message))) {
        log.info("passive reply gate chose to stay silent", {
          messageId: message.id,
          channelId: message.channelId,
        });
        return;
      }
    }

    // Sandi has decided to engage. Create an on-demand thread for a busy
    // top-level channel so the reply stays grouped, unless that channel is
    // configured to keep Sandi conversation inline.
    const channel = asConversationChannel(message.channel);
    if (channel && !thread) {
      const strippedContent = stripBotMention(
        message.content,
        this.#client.user?.id,
      );
      if (this.#shouldReplyInlineInChannel(channel)) {
        const author = await this.#participantFromMessage(message);
        log.info("engaging top-level channel message inline", {
          messageId: message.id,
          channelId: channel.id,
          mustRespond,
        });
        await this.#enqueueChannelTurn({
          channel,
          author,
          messageId: message.id,
          input: strippedContent,
          metadata: await messageMetadata(message),
          toolContext: toolContextFromMessage(message, author),
          title: channel.name,
          replyToMessageId: message.id,
        });
        return;
      }
      log.info("engaging top-level channel message via on-demand thread", {
        messageId: message.id,
        channelId: channel.id,
        mustRespond,
      });
      await this.#startThreadForChannelMessage({
        message,
        channel,
        strippedContent,
      });
      return;
    }

    log.info("engaging message via one-off reply", {
      messageId: message.id,
      channelId: message.channelId,
      mustRespond,
    });
    this.#queue.enqueue(
      `oneoff:${message.guildId ?? "dm"}:${message.channelId}`,
      message.id,
      async (signal) => {
        await this.#runOneOffMention(message, signal);
      },
    );
  }

  async #isReplyToSandi(message: Message): Promise<boolean> {
    const referencedId = message.reference?.messageId;
    if (!referencedId) return false;
    const botId = this.#client.user?.id;
    if (!botId) return false;
    try {
      const referenced = await message.channel.messages.fetch(referencedId);
      return referenced.author.id === botId;
    } catch {
      return false;
    }
  }

  async #isIgnoredChannel(message: Message): Promise<boolean> {
    const ignored = await this.#loadIgnoredChannels();
    if (ignored.size === 0) return false;
    if (ignored.has(message.channelId)) return true;
    const parentId = isRecord(message.channel)
      ? message.channel["parentId"]
      : undefined;
    return typeof parentId === "string" && ignored.has(parentId);
  }

  #shouldReplyInlineInChannel(channel: ConversationDiscordChannel): boolean {
    if (this.#config.discord.inlineReplyChannelIds.includes(channel.id)) {
      return true;
    }
    return this.#config.discord.inlineReplyChannelNames.includes(
      channel.name.toLowerCase(),
    );
  }

  async #shouldRespondToPassiveMessage(message: Message): Promise<boolean> {
    if (!message.content.trim() && message.attachments.size === 0) return false;
    const author = await this.#participantFromMessage(message);
    // Show the typing indicator while the gate decides so onlookers can tell
    // Sandi is weighing the message rather than frozen. The reaction fallback
    // is intentionally disabled: a gate that lands on IGNORE must leave no
    // visible trace on a message that was not meant for her.
    void sendActivitySignal({
      channelId: message.channelId,
      token: this.#config.discord.token,
      reactOnTypingFailure: false,
    });
    const typingTimer = setInterval(() => {
      void sendActivitySignal({
        channelId: message.channelId,
        token: this.#config.discord.token,
        reactOnTypingFailure: false,
      });
    }, TYPING_INTERVAL_MS);
    try {
      const response = await this.#provider.generateTurn({
        conversationId: `passive-gate:${message.id}`,
        instructions: PASSIVE_REPLY_GATE_INSTRUCTIONS,
        input: await passiveReplyGateInput(
          message,
          this.#client.user?.username,
        ),
        sessionMode: "none",
        accountRouting: accountRoutingForOneOffTurn(author),
        memoryContext: this.#memoryContext(undefined, [author]),
        thinking: PASSIVE_REPLY_GATE_THINKING,
        timeoutMs: PASSIVE_REPLY_GATE_TIMEOUT_MS,
      });
      const respond = parsePassiveReplyGateDecision(response.text);
      log.info("passive reply gate decision", {
        messageId: message.id,
        channelId: message.channelId,
        respond,
      });
      return respond;
    } catch (error) {
      log.warn("passive reply gate failed; staying silent", {
        messageId: message.id,
        channelId: message.channelId,
        error: errorMessage(error),
      });
      return false;
    } finally {
      clearInterval(typingTimer);
    }
  }

  async #handleMessageReaction(
    kind: "added" | "removed",
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    try {
      const fullUser = await fetchReactionUser(user);
      if (fullUser.bot) return;
      const fullReaction = await fetchReaction(reaction);
      const message = await fetchReactionMessage(fullReaction);
      const botId = this.#client.user?.id;
      if (!botId || message.author.id !== botId) return;

      const conversationId =
        await this.#conversationIdForReactionMessage(message);
      if (!conversationId) return;

      await this.#reactions.capture({
        conversationId,
        kind,
        emoji: reactionEmojiLabel(fullReaction),
        userId: fullUser.id,
        username: reactionUsername(fullUser),
        messageId: message.id,
        messageUrl: message.url,
        messageContent: message.content,
        at: new Date().toISOString(),
      });
      log.info("captured reaction to sandi message", {
        conversationId,
        messageId: message.id,
        userId: fullUser.id,
        kind,
      });
    } catch (error) {
      log.warn("failed to capture reaction to sandi message", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #handleInteraction(interaction: Interaction): Promise<void> {
    if (await this.#reminders.handleInteraction(interaction)) return;
    if (await this.#todoList.handleInteraction(interaction)) return;
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "sandi") return;

    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    if (!group && subcommand === "help") {
      await interaction.reply({
        content: HELP_MESSAGE,
        allowedMentions: { parse: [] },
        ephemeral: true,
      });
      return;
    }
    if (!group && subcommand === "stop") {
      await this.#replyToStopInteraction(interaction);
      return;
    }
    if (!group && subcommand === "ignore") {
      await this.#replyToIgnoreInteraction(interaction);
      return;
    }
    if (!group && subcommand === "listen") {
      await this.#replyToListenInteraction(interaction);
      return;
    }
    if (!group && subcommand === "todo") {
      await this.#replyToTodoInteraction(interaction);
      return;
    }
    if (!group && subcommand === "status") {
      await this.#replyToStatusInteraction(interaction);
      return;
    }
    if (!group && subcommand === "auth") {
      await this.#replyToAuthInteraction(interaction);
      return;
    }
    if (group === "events" && subcommand === "list") {
      await this.#replyToEventsListInteraction(interaction);
      return;
    }
    if (group === "reminders" && subcommand === "list") {
      await this.#replyToRemindersListInteraction(interaction);
    }
  }

  async #replyToStopInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const queueKey = queueKeyFromInteraction(interaction);
    const aborted = queueKey ? this.#queue.abortActive(queueKey) : false;
    const content = aborted
      ? "Asked the current Sandi turn in this conversation to stop."
      : "No active Sandi turn is running in this conversation.";
    await interaction.reply({
      content,
      allowedMentions: { parse: [] },
      ephemeral: true,
    });
  }

  async #replyToAuthInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    // Load identities fresh (this gate mints a credential, so it must not serve a
    // stale cache) and delegate the auth-grade resolution and code issuance to
    // issueDeviceCode. A stranger, or a member configured without an immutable
    // Discord account id, gets no code.
    const identities = await loadHumanIdentities(this.#config.paths.configDirs);
    const result = await issueDeviceCode({
      identities,
      pairingsPath: defaultApiPairingsPath(this.#config.paths.dataDir),
      discordUserId: interaction.user.id,
    });
    if (!result.ok) {
      await interaction.reply({
        content:
          "I can only pair devices for a recognized household member, and I do not have you on file yet. Ask an admin to add you (with your Discord account id) to Sandi's identities first.",
        allowedMentions: { parse: [] },
        ephemeral: true,
      });
      return;
    }

    const minutes = Math.round(PAIRING_TTL_MS / 60_000);
    log.info("issued API pairing code", { identityId: result.identityId });
    await interaction.reply({
      content: [
        "Here is your one-time pairing code for connecting a desktop client to Sandi:",
        "",
        `\`\`\`\n${result.display}\n\`\`\``,
        `It is valid for ${minutes} minutes and can be used once. In your desktop client, choose to pair a new device and paste this code. It links that device to your Sandi identity (and your GitHub account if one is on file).`,
        "Running this command again replaces any previous code.",
      ].join("\n"),
      allowedMentions: { parse: [] },
      ephemeral: true,
    });
  }

  async #replyToIgnoreInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "I can only ignore channels and threads inside a server.",
        allowedMentions: { parse: [] },
        ephemeral: true,
      });
      return;
    }

    const queueKey = queueKeyFromInteraction(interaction);
    const aborted = queueKey ? this.#queue.abortActive(queueKey) : false;
    const targetId =
      conversationStorageIdFromInteraction(interaction) ??
      interaction.channelId;
    await this.#addIgnoredChannel(targetId);
    log.info("added channel or thread to ignore list", {
      targetId,
      guildId: interaction.guildId,
      stoppedActiveTurn: aborted,
    });

    const place = asThread(interaction.channel) ? "thread" : "channel";
    const stopNote = aborted
      ? " I also stopped the turn that was running here."
      : "";
    await interaction.reply({
      content: `Okay, I'll ignore this ${place} from now on and only chime in when someone @-mentions me here.${stopNote} Run \`/sandi listen\` to undo this.`,
      allowedMentions: { parse: [] },
      ephemeral: true,
    });
  }

  async #replyToListenInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "I can only manage ignored channels and threads in a server.",
        allowedMentions: { parse: [] },
        ephemeral: true,
      });
      return;
    }

    const targetId =
      conversationStorageIdFromInteraction(interaction) ??
      interaction.channelId;
    const removed = await this.#removeIgnoredChannel(targetId);
    log.info("removed channel or thread from ignore list", {
      targetId,
      guildId: interaction.guildId,
      wasIgnored: removed,
    });

    const place = asThread(interaction.channel) ? "thread" : "channel";
    const content = removed
      ? `Back to listening in this ${place}. I'll chime in again whenever something seems meant for me.`
      : `I'm already listening in this ${place}; it wasn't on my ignore list.`;
    await interaction.reply({
      content,
      allowedMentions: { parse: [] },
      ephemeral: true,
    });
  }

  async #startThreadForChannelMessage(input: {
    message: Message;
    channel: ConversationDiscordChannel;
    strippedContent: string;
  }): Promise<void> {
    if (!input.message.inGuild()) {
      log.warn("cannot create Sandi message thread outside a guild", {
        messageId: input.message.id,
        channelId: input.message.channelId,
      });
      return;
    }

    const prompt =
      input.strippedContent || "Sandi engaged without additional text.";
    const author = await this.#participantFromMessage(input.message);
    let thread = asThread(input.message.thread);
    let createdThread = false;

    if (!thread) {
      try {
        thread = await input.message.startThread({
          name: MENTION_THREAD_PLACEHOLDER_TITLE,
          autoArchiveDuration: DEFAULT_MENTION_THREAD_AUTO_ARCHIVE,
          reason: `Sandi conversation requested by ${input.message.author.tag}`,
        });
        createdThread = true;
      } catch (error) {
        log.error("failed to create Sandi message thread", {
          messageId: input.message.id,
          channelId: input.channel.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await sendThreadCreationFailureNotice(input.message, error);
        return;
      }
    }

    const source: DiscordThreadConversationSource = {
      kind: "message_thread",
      originChannelId: input.channel.id,
      originMessageId: input.message.id,
      originMessageUrl: input.message.url,
      starterMessage: prompt,
      createdByUserId: author.platformUserId,
    };

    const title = createdThread
      ? await this.#titleCreatedMessageThread({
          thread,
          originMessage: input.message,
          originChannel: input.channel,
          prompt,
          author,
        })
      : thread.name;

    await this.#enqueueThreadTurn({
      thread,
      author,
      messageId: input.message.id,
      input: prompt,
      metadata: await messageThreadStarterMetadata({
        originMessage: input.message,
        thread,
      }),
      toolContext: toolContextFromThreadStarter({
        originMessage: input.message,
        thread,
        author,
      }),
      title,
      source,
      reactOnTypingFailure: false,
      failureReplyToMessageId: false,
    });
  }

  async #titleCreatedMessageThread(input: {
    thread: AnyThreadChannel;
    originMessage: Message;
    originChannel: ConversationDiscordChannel;
    prompt: string;
    author: ConversationParticipant;
  }): Promise<string> {
    let title: string | undefined;
    try {
      const response = await this.#provider.generateTurn({
        conversationId: `thread-title:${input.originMessage.id}`,
        instructions: THREAD_TITLE_INSTRUCTIONS,
        input: threadTitleRequestInput({
          authorUsername: input.author.username,
          authorDisplayName: input.author.displayName,
          channelName: input.originChannel.name,
          message: input.prompt,
        }),
        sessionMode: "none",
        accountRouting: accountRoutingForOneOffTurn(input.author),
        memoryContext: this.#memoryContext(undefined, [input.author]),
        thinking: MENTION_THREAD_TITLE_THINKING,
        timeoutMs: MENTION_THREAD_TITLE_TIMEOUT_MS,
      });
      title = normalizeGeneratedThreadTitle(response.text);
      if (!title) {
        log.warn("thread title provider returned an empty title", {
          messageId: input.originMessage.id,
          threadId: input.thread.id,
          responseLength: response.text.length,
        });
      }
    } catch (error) {
      log.warn("failed to generate Sandi message thread title", {
        messageId: input.originMessage.id,
        threadId: input.thread.id,
        error: errorMessage(error),
      });
    }

    if (!title) return input.thread.name;

    try {
      const renamed = await input.thread.setName(
        title,
        `Sandi title generated from ${input.originMessage.author.tag}'s starter message`,
      );
      log.info("renamed Sandi message thread", {
        messageId: input.originMessage.id,
        threadId: renamed.id,
        title: renamed.name,
      });
      return renamed.name;
    } catch (error) {
      log.warn("failed to rename Sandi message thread", {
        messageId: input.originMessage.id,
        threadId: input.thread.id,
        title,
        error: errorMessage(error),
      });
      return input.thread.name;
    }
  }

  async #replyToTodoInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const result = await this.#todoList.createPinnedList(interaction);
    if (!result) {
      await interaction.editReply({
        content:
          "I can only create todo lists inside sendable server channels.",
        allowedMentions: { parse: [] },
      });
      return;
    }

    const pinNote = result.pinned
      ? "Pinned it too."
      : "I made the list, but couldn't pin it — Discord may be missing the Manage Messages permission here.";
    await interaction.editReply({
      content: `Created an interactive todo list: ${result.messageUrl}\n${pinNote}`,
      allowedMentions: { parse: [] },
    });
  }

  async #replyToStatusInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({
      content: await this.#buildStatusContent(
        queueKeyFromInteraction(interaction),
        await this.#statusContextSize(interaction),
      ),
      allowedMentions: { parse: [] },
    });
  }

  async #replyToEventsListInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const scope = interaction.options.getString("scope") ?? "current";
    const currentTarget = eventTargetFromInteraction(interaction);
    const allEvents = await listEvents(this.#config.paths.eventsRoot);
    const events =
      scope === "all" || !currentTarget
        ? allEvents
        : allEvents.filter((item) =>
            eventTargetMatches(item.event, currentTarget),
          );
    await interaction.editReply({
      content: formatScheduledEvents({
        events,
        scope: scope === "all" ? "all" : "current",
        currentTarget,
        totalEvents: allEvents.length,
      }),
      allowedMentions: { parse: [] },
    });
  }

  async #replyToRemindersListInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const scope = interaction.options.getString("scope") ?? "current";
    const currentTarget = eventTargetFromInteraction(interaction);
    const reminders = await this.#reminders.listForTarget({
      target: currentTarget,
      scope: scope === "all" ? "all" : "current",
    });
    const allReminders = await this.#reminders.listForTarget({
      target: undefined,
      scope: "all",
    });
    await interaction.editReply({
      content: this.#reminders.formatList({
        reminders,
        scope: scope === "all" ? "all" : "current",
        currentTarget,
        totalReminders: allReminders.length,
      }),
      allowedMentions: { parse: [] },
    });
  }

  async #enqueueThreadTurn(input: {
    thread: AnyThreadChannel;
    author: ConversationParticipant;
    messageId: string;
    input: string;
    metadata: string;
    toolContext: DiscordToolContext;
    title: string;
    replyToMessageId?: string;
    source?: DiscordThreadConversationSource;
    reactOnTypingFailure?: boolean;
    failureReplyToMessageId?: string | false;
  }): Promise<void> {
    const manifest = await this.#loadThreadManifest(
      input.thread,
      input.title,
      input.author,
      input.source,
    );
    const current = await this.#conversations.addParticipant({
      storageId: discordConversationStorageId(manifest),
      manifest,
      participant: input.author,
    });
    this.#queue.enqueue(
      current.canonicalId,
      input.messageId,
      async (signal) => {
        const turnInput = {
          channel: input.thread,
          conversation: current,
          author: input.author,
          messageId: input.messageId,
          input: input.input,
          metadata: input.metadata,
          toolContext: input.toolContext,
          signal,
        };
        let nextTurnInput: RunTurnInput = input.replyToMessageId
          ? { ...turnInput, replyToMessageId: input.replyToMessageId }
          : turnInput;
        if (input.reactOnTypingFailure !== undefined) {
          nextTurnInput = {
            ...nextTurnInput,
            reactOnTypingFailure: input.reactOnTypingFailure,
          };
        }
        if (input.failureReplyToMessageId !== undefined) {
          nextTurnInput = {
            ...nextTurnInput,
            failureReplyToMessageId: input.failureReplyToMessageId,
          };
        }
        await this.#runTurn(nextTurnInput);
      },
    );
  }

  async #enqueueChannelTurn(input: {
    channel: ConversationDiscordChannel;
    author: ConversationParticipant;
    messageId: string;
    input: string;
    metadata: string;
    toolContext: DiscordToolContext;
    title: string;
    replyToMessageId?: string;
    suppressFinalResponse?: boolean;
  }): Promise<void> {
    const manifest = await this.#loadChannelManifest(
      input.channel,
      input.title,
      input.author,
    );
    const current = await this.#conversations.addParticipant({
      storageId: discordConversationStorageId(manifest),
      manifest,
      participant: input.author,
    });
    this.#queue.enqueue(
      current.canonicalId,
      input.messageId,
      async (signal) => {
        const baseTurnInput = {
          channel: input.channel,
          conversation: current,
          author: input.author,
          messageId: input.messageId,
          input: input.input,
          metadata: input.metadata,
          toolContext: input.toolContext,
          signal,
        };
        const turnInput = input.suppressFinalResponse
          ? { ...baseTurnInput, suppressFinalResponse: true }
          : baseTurnInput;
        await this.#runTurn(
          input.replyToMessageId
            ? { ...turnInput, replyToMessageId: input.replyToMessageId }
            : turnInput,
        );
      },
    );
  }

  // Leases hands on the author's desktop when their machine is linked, so a
  // Discord turn can read files and run shell commands there in addition to its
  // server-side tools.
  #leaseDesktopHands(
    author: ConversationParticipant,
    signal: AbortSignal | undefined,
  ): DesktopHandsLease | undefined {
    return leaseDesktopHands({
      hands: this.#desktopHands,
      identityId: author.identityId,
      signal,
    });
  }

  async #runTurn(input: RunTurnInput): Promise<void> {
    log.info("starting conversation turn", {
      conversationId: input.conversation.canonicalId,
      messageId: input.messageId,
      channelId: input.channel.id,
    });
    void sendActivitySignal({
      channelId: input.channel.id,
      messageId: input.messageId,
      token: this.#config.discord.token,
      reactOnTypingFailure: input.reactOnTypingFailure ?? true,
    });
    const typingTimer = setInterval(() => {
      void sendActivitySignal({
        channelId: input.channel.id,
        token: this.#config.discord.token,
        reactOnTypingFailure: false,
      });
    }, TYPING_INTERVAL_MS);

    try {
      const instructions = await this.#contextCompiler.compile({
        conversation: input.conversation,
        deliveryInstructions: DISCORD_DELIVERY_INSTRUCTIONS,
        skillHintQuery: input.input,
      });
      const metadata = await this.#metadataWithReactionDigest({
        conversation: input.conversation,
        messageId: input.messageId,
        metadata: input.metadata,
      });
      log.info("starting provider turn", {
        conversationId: input.conversation.canonicalId,
        messageId: input.messageId,
      });
      const lease = this.#leaseDesktopHands(input.author, input.signal);
      let response: ProviderTurnResponse;
      try {
        const providerRequest = {
          conversationId: input.conversation.canonicalId,
          instructions,
          input: formatUserTurn(input.author, input.input, metadata),
          sessionMode: "persistent" as const,
          platformContext: input.toolContext,
          accountRouting: accountRoutingForPersistentTurn(input.author),
          surfaceContext: DISCORD_SURFACE_CONTEXT,
          memoryContext: this.#memoryContext(input.conversation),
          ...(lease ? { localToolBroker: lease.ticket } : {}),
        };
        response = await this.#provider.generateTurn(
          input.signal
            ? { ...providerRequest, signal: input.signal }
            : providerRequest,
        );
      } finally {
        lease?.revoke();
      }
      log.info("provider turn finished", {
        conversationId: input.conversation.canonicalId,
        messageId: input.messageId,
        responseLength: response.text.length,
        deliverySideEffects: response.deliverySideEffects,
      });
      if (input.suppressFinalResponse) {
        if (!response.deliverySideEffects && response.text.trim()) {
          log.info("suppressing provider final text for todo channel turn", {
            conversationId: input.conversation.canonicalId,
            messageId: input.messageId,
            responseLength: response.text.length,
          });
        }
        return;
      }

      const responseInput = {
        channel: input.channel,
        response,
      };
      await this.#sendProviderResponse(
        input.replyToMessageId
          ? { ...responseInput, replyToMessageId: input.replyToMessageId }
          : responseInput,
      );
    } catch (error) {
      log.error("conversation turn failed", {
        conversationId: input.conversation.canonicalId,
        messageId: input.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      const failureReplyToMessageId =
        input.failureReplyToMessageId === false
          ? undefined
          : (input.failureReplyToMessageId ?? input.messageId);
      const failureNoticeInput = {
        channel: input.channel,
        messageId: input.messageId,
        cooldownKey: input.conversation.canonicalId,
        error,
      };
      await this.#sendProviderFailureNotice(
        failureReplyToMessageId
          ? { ...failureNoticeInput, replyToMessageId: failureReplyToMessageId }
          : failureNoticeInput,
      );
    } finally {
      clearInterval(typingTimer);
    }
  }

  async #enqueueEventTurn(trigger: EventTrigger): Promise<void> {
    try {
      const channel = await this.#fetchEventTarget(trigger);
      if (!channel) return;

      const eventParticipant = eventAuthor(trigger.event);
      const conversation = await this.#loadEventConversation(
        trigger,
        channel,
        eventParticipant,
      );
      this.#queue.enqueue(
        conversation.canonicalId,
        trigger.id,
        async (signal) => {
          await this.#runTurn({
            channel,
            conversation,
            author: eventParticipant,
            messageId: `event:${trigger.id}`,
            input: formatEventTurn(trigger),
            metadata: eventMetadata(trigger, channel),
            toolContext: toolContextFromChannel(
              channel,
              trigger.id,
              eventParticipant,
            ),
            signal,
          });
        },
      );
    } catch (error) {
      log.error("event turn failed to enqueue", {
        eventId: trigger.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #fetchEventTarget(
    trigger: EventTrigger,
  ): Promise<ConversationDiscordChannel | undefined> {
    const targetId =
      trigger.event.target.kind === "thread"
        ? trigger.event.target.threadId
        : trigger.event.target.channelId;
    const channel = await this.#client.channels.fetch(targetId);
    const target = asConversationChannel(channel);
    if (!target) {
      log.error("event target is not an available text channel", {
        eventId: trigger.id,
        targetKind: trigger.event.target.kind,
        targetId,
      });
      return undefined;
    }
    if (trigger.event.target.kind === "thread" && !asThread(channel)) {
      log.error("event thread target is not a thread", {
        eventId: trigger.id,
        threadId: trigger.event.target.threadId,
      });
      return undefined;
    }
    if (trigger.event.target.kind === "channel" && asThread(channel)) {
      log.error("event channel target resolved to a thread", {
        eventId: trigger.id,
        channelId: trigger.event.target.channelId,
      });
      return undefined;
    }
    return target;
  }

  async #loadEventConversation(
    trigger: EventTrigger,
    channel: ConversationDiscordChannel,
    starter: ConversationParticipant,
  ): Promise<ConversationManifest> {
    if (trigger.event.target.kind === "thread") {
      return this.#loadThreadManifest(channel, channel.name, starter);
    }
    return this.#loadChannelManifest(channel, channel.name, starter);
  }

  async #runOneOffMention(
    message: Message,
    signal?: AbortSignal,
  ): Promise<void> {
    const author = await this.#participantFromMessage(message);
    const metadata = await messageMetadata(message);
    const input =
      stripBotMention(message.content, this.#client.user?.id) ||
      message.content.trim() ||
      "Sandi was mentioned without additional text.";

    const channel = message.channel;
    if (!channel.isSendable()) return;

    log.info("starting one-off mention turn", {
      messageId: message.id,
      channelId: message.channelId,
    });
    void sendActivitySignal({
      channelId: channel.id,
      messageId: message.id,
      token: this.#config.discord.token,
      reactOnTypingFailure: true,
    });
    const typingTimer = setInterval(() => {
      void sendActivitySignal({
        channelId: channel.id,
        token: this.#config.discord.token,
        reactOnTypingFailure: false,
      });
    }, TYPING_INTERVAL_MS);

    try {
      const instructions = await this.#contextCompiler.compileOneOff({
        author,
        title: "One-Off Discord Mention",
        metadata,
        deliveryInstructions: DISCORD_DELIVERY_INSTRUCTIONS,
        skillHintQuery: input,
      });
      log.info("starting provider turn", {
        conversationId: `oneoff:${message.id}`,
        messageId: message.id,
      });
      const lease = this.#leaseDesktopHands(author, signal);
      let response: ProviderTurnResponse;
      try {
        const providerRequest = {
          conversationId: `oneoff:${message.id}`,
          instructions,
          input: formatUserTurn(author, input, metadata),
          sessionMode: "none" as const,
          platformContext: toolContextFromMessage(message, author),
          accountRouting: accountRoutingForOneOffTurn(author),
          surfaceContext: DISCORD_SURFACE_CONTEXT,
          memoryContext: this.#memoryContext(undefined, [author]),
          ...(lease ? { localToolBroker: lease.ticket } : {}),
        };
        response = await this.#provider.generateTurn(
          signal ? { ...providerRequest, signal } : providerRequest,
        );
      } finally {
        lease?.revoke();
      }
      log.info("provider turn finished", {
        conversationId: `oneoff:${message.id}`,
        messageId: message.id,
        responseLength: response.text.length,
        deliverySideEffects: response.deliverySideEffects,
      });
      await this.#sendProviderResponse({
        channel,
        response,
        replyToMessageId: message.id,
      });
    } catch (error) {
      log.error("one-off mention failed", {
        messageId: message.id,
        channelId: message.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.#sendProviderFailureNotice({
        channel,
        messageId: message.id,
        cooldownKey: `oneoff:${message.guildId ?? "dm"}:${message.channelId}`,
        replyToMessageId: message.id,
        error,
      });
    } finally {
      clearInterval(typingTimer);
    }
  }

  async #buildStatusContent(
    queueKey: string | undefined,
    contextTokens?: number,
  ): Promise<string> {
    const queue = queueKey
      ? this.#queue.status(queueKey)
      : { running: false, queuedJobs: 0 };
    const input = {
      queueRunning: queue.running,
      queuedJobs: queue.queuedJobs,
      model: this.#config.pi.model,
      provider: this.#config.pi.provider,
      thinking: this.#config.pi.thinking,
      tokenUsagePath: this.#config.pi.tokenUsagePath,
      accounts: this.#config.pi.accountRouting?.accounts ?? [],
    };
    return botStatusMessage(
      contextTokens !== undefined ? { ...input, contextTokens } : input,
    );
  }

  async #statusContextSize(
    interaction: ChatInputCommandInteraction,
  ): Promise<number | undefined> {
    const storageId = conversationStorageIdFromInteraction(interaction);
    if (!storageId) return undefined;
    const conversation = await this.#conversations.get(storageId);
    if (!conversation) return undefined;

    try {
      const compiled = await this.#contextCompiler.compile({
        conversation,
        deliveryInstructions: DISCORD_DELIVERY_INSTRUCTIONS,
      });
      return estimatePromptTokens(compiled);
    } catch (error) {
      log.warn("failed to compile context for status", {
        storageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async #sendProviderResponse(input: {
    channel: FailureNoticeChannel;
    response: ProviderTurnResponse;
    replyToMessageId?: string;
  }): Promise<void> {
    // Tool/runtime Discord sends are already visible to the user. Treat their
    // marker as runtime evidence to suppress the automatic final-text post.
    if (input.response.deliverySideEffects) return;

    const content = input.response.text.trim();
    if (!content) return;

    try {
      const chunks = chunkDiscordMessage(content);
      for (const [index, chunk] of chunks.entries()) {
        const options: MessageCreateOptions = {
          content: chunk,
          allowedMentions: { parse: [], repliedUser: false },
        };
        if (index === 0 && input.replyToMessageId) {
          options.reply = {
            messageReference: input.replyToMessageId,
            failIfNotExists: false,
          };
        }
        await input.channel.send(options);
      }
    } catch (error) {
      log.error("failed to send provider response", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #sendProviderFailureNotice(input: {
    channel: FailureNoticeChannel;
    messageId: string;
    cooldownKey: string;
    replyToMessageId?: string;
    error: unknown;
  }): Promise<void> {
    if (!(input.error instanceof ProviderTurnError)) return;
    if (input.error.reason === "aborted") return;
    if (input.messageId.startsWith("event:")) return;

    const cooldownKey = `${input.cooldownKey}:${input.error.reason}`;
    const now = Date.now();
    const lastNotice = this.#failureNotices.get(cooldownKey);
    if (lastNotice && now - lastNotice < FAILURE_NOTICE_COOLDOWN_MS) return;
    setBoundedMapEntry(
      this.#failureNotices,
      cooldownKey,
      now,
      MAX_FAILURE_NOTICE_COOLDOWNS,
    );

    const options: MessageCreateOptions = {
      content: providerFailureMessage(input.error),
      allowedMentions: { parse: [], repliedUser: false },
    };
    if (input.replyToMessageId) {
      options.reply = {
        messageReference: input.replyToMessageId,
        failIfNotExists: false,
      };
    }

    try {
      await input.channel.send(options);
    } catch (error) {
      log.error("failed to send provider failure notice", {
        messageId: input.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #loadThreadManifest(
    thread: ConversationDiscordChannel,
    title: string,
    starter: ConversationParticipant,
    source?: DiscordThreadConversationSource,
  ): Promise<ConversationManifest> {
    const channelId = thread.parentId ?? thread.id;
    const manifestInput = {
      guildId: thread.guildId,
      channelId,
      threadId: thread.id,
      title,
      starter,
    };
    const manifest = await this.#conversations.getOrCreate({
      storageId: thread.id,
      fallback: buildDiscordThreadManifest(
        source ? { ...manifestInput, source } : manifestInput,
      ),
    });
    return withDiscordSurfacePrompt(manifest);
  }

  async #loadChannelManifest(
    channel: ConversationDiscordChannel,
    title: string,
    starter: ConversationParticipant,
  ): Promise<ConversationManifest> {
    // Read-or-create and apply the todo-channel prompt in one cross-process
    // lock. A bare getOrCreate then save would clobber a participant another
    // process added via addParticipant in the gap between the two.
    return this.#conversations.applyManaged({
      storageId: channel.id,
      fallback: buildDiscordChannelManifest({
        guildId: channel.guildId,
        channelId: channel.id,
        title,
        starter,
      }),
      mutate: (manifest) => withTodoChannelPrompt(manifest, channel.name),
    });
  }

  async #conversationIdForReactionMessage(
    message: Message,
  ): Promise<ConversationManifest["canonicalId"] | undefined> {
    if (!message.guildId) return undefined;
    const thread = asThread(message.channel);
    if (thread) {
      if (!(await this.#isManagedThread(thread))) return undefined;
      return canonicalDiscordThreadId(
        message.guildId,
        thread.parentId ?? thread.id,
        thread.id,
      );
    }
    const channel = asConversationChannel(message.channel);
    if (!channel) return undefined;
    return canonicalDiscordChannelId(message.guildId, channel.id);
  }

  async #isManagedThread(thread: AnyThreadChannel): Promise<boolean> {
    if (this.#isSandiForumThread(thread)) return true;
    const manifest = await this.#conversations.get(thread.id);
    return isDiscordThreadConversation(manifest);
  }

  #isSandiForumThread(thread: AnyThreadChannel): boolean {
    const forum = this.#forum;
    if (!forum) return thread.parentId === this.#config.discord.forumChannelId;
    return thread.parentId === forum.id;
  }

  #isBotMentioned(message: Message): boolean {
    const botId = this.#client.user?.id;
    if (!botId) return false;
    return message.mentions.users.has(botId);
  }

  async #metadataWithReactionDigest(input: {
    conversation: ConversationManifest;
    messageId: string;
    metadata: string;
  }): Promise<string> {
    if (input.messageId.startsWith("event:")) return input.metadata;
    const digest = await this.#reactions.drain(input.conversation.canonicalId);
    if (!digest) return input.metadata;
    return [input.metadata, "", digest].join("\n");
  }

  #memoryContext(
    conversation: ConversationManifest | undefined,
    participants?: ConversationParticipant[],
  ): MemoryContext {
    const input = {
      dataDir: this.#config.paths.dataDir,
      participants: participants ?? conversation?.participants ?? [],
    };
    if (!conversation) return buildMemoryContext(input);
    return buildMemoryContext({ ...input, conversation });
  }

  async #participantFromMessage(
    message: Message,
  ): Promise<ConversationParticipant> {
    return this.#withKnownIdentity(participantFromMessage(message));
  }

  async #withKnownIdentity(
    participant: ConversationParticipant,
  ): Promise<ConversationParticipant> {
    const identities = await this.#loadIdentities();
    const identity = findHumanIdentity({
      identities,
      platform: participant.platform,
      platformUserId: participant.platformUserId,
      username: participant.username,
    });
    if (!identity) return participant;
    return { ...participant, identityId: identity.id };
  }

  #loadIdentities(): Promise<HumanIdentityConfig> {
    this.#identities ??= loadHumanIdentities(this.#config.paths.configDirs);
    return this.#identities;
  }

  #loadIgnoredChannels(): Promise<Set<string>> {
    this.#ignoredChannels ??= loadIgnoredConversationChannels(
      this.#config.paths.dataDir,
    );
    return this.#ignoredChannels;
  }

  async #addIgnoredChannel(channelId: string): Promise<void> {
    const updated = await appendIgnoredConversationChannel(
      this.#config.paths.dataDir,
      channelId,
    );
    this.#ignoredChannels = Promise.resolve(updated);
  }

  async #removeIgnoredChannel(channelId: string): Promise<boolean> {
    const { channels, removed } = await removeIgnoredConversationChannel(
      this.#config.paths.dataDir,
      channelId,
    );
    this.#ignoredChannels = Promise.resolve(channels);
    return removed;
  }
}

type ThreadCheckable = {
  isThread(): this is AnyThreadChannel;
};

function asThread(
  channel: ThreadCheckable | null | undefined,
): AnyThreadChannel | undefined {
  if (!channel?.isThread()) return undefined;
  return channel;
}

function asConversationChannel(
  channel: unknown,
): ConversationDiscordChannel | undefined {
  return isConversationChannel(channel) ? channel : undefined;
}

function asTodoChannel(
  channel: unknown,
): ConversationDiscordChannel | undefined {
  const conversationChannel = asConversationChannel(channel);
  if (!conversationChannel) return undefined;
  if (conversationChannel.isThread?.()) return undefined;
  return isTodoChannelName(conversationChannel.name)
    ? conversationChannel
    : undefined;
}

function isTodoChannelName(name: string): boolean {
  const normalized = name.trim().toLocaleLowerCase();
  return TODO_CHANNEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function withTodoChannelPrompt(
  manifest: ConversationManifest,
  channelName: string,
): ConversationManifest {
  if (!isTodoChannelName(channelName)) return manifest;
  if (manifest.surfacePrompt === TODO_CHANNEL_SURFACE_PROMPT) return manifest;
  return { ...manifest, surfacePrompt: TODO_CHANNEL_SURFACE_PROMPT };
}

async function fetchReaction(
  reaction: MessageReaction | PartialMessageReaction,
): Promise<MessageReaction> {
  if (reaction.partial) return reaction.fetch();
  return reaction;
}

async function fetchReactionMessage(
  reaction: MessageReaction,
): Promise<Message> {
  const message = reaction.message;
  if (message.partial) return message.fetch();
  return message;
}

async function fetchReactionUser(user: User | PartialUser): Promise<User> {
  if (user.partial) return user.fetch();
  return user;
}

function reactionEmojiLabel(reaction: MessageReaction): string {
  const id = reaction.emoji.id;
  const name = reaction.emoji.name;
  if (id && name) return `${name}:${id}`;
  if (name) return name;
  return "unknown emoji";
}

function reactionUsername(user: User): string {
  return user.globalName ?? user.username;
}

// Best-effort error reply when an interaction handler rejected. Only replies if
// the interaction can still be answered and has not been already, and swallows
// its own failure: an expired or already-answered interaction leaves nothing to
// do but log (which the caller already did).
async function respondToFailedInteraction(
  interaction: Interaction,
): Promise<void> {
  if (!interaction.isRepliable()) return;
  if (interaction.replied || interaction.deferred) return;
  try {
    await interaction.reply({
      content: "Something went wrong handling that command. Please try again.",
      allowedMentions: { parse: [] },
      ephemeral: true,
    });
  } catch {
    // The interaction may have expired or already been answered.
  }
}

function queueKeyFromInteraction(
  interaction: ChatInputCommandInteraction,
): string | undefined {
  if (!interaction.guildId) return undefined;
  const thread = asThread(interaction.channel);
  if (thread) {
    return canonicalDiscordThreadId(
      interaction.guildId,
      thread.parentId ?? thread.id,
      thread.id,
    );
  }
  return canonicalDiscordChannelId(interaction.guildId, interaction.channelId);
}

function conversationStorageIdFromInteraction(
  interaction: ChatInputCommandInteraction,
): string | undefined {
  if (!interaction.guildId) return undefined;
  const thread = asThread(interaction.channel);
  return thread?.id ?? interaction.channelId;
}

function eventTargetFromInteraction(
  interaction: ChatInputCommandInteraction,
): EventTarget | undefined {
  if (!interaction.guildId) return undefined;
  const thread = asThread(interaction.channel);
  if (thread) return { kind: "thread", threadId: thread.id };
  return { kind: "channel", channelId: interaction.channelId };
}

function eventTargetMatches(event: SandiEvent, target: EventTarget): boolean {
  if (event.target.kind === "thread" && target.kind === "thread") {
    return event.target.threadId === target.threadId;
  }
  if (event.target.kind === "channel" && target.kind === "channel") {
    return event.target.channelId === target.channelId;
  }
  return false;
}

function formatScheduledEvents(input: {
  events: StoredEvent[];
  scope: "all" | "current";
  currentTarget: EventTarget | undefined;
  totalEvents: number;
}): string {
  const heading =
    input.scope === "all"
      ? `🗓️ Scheduled events — all (${input.totalEvents})`
      : `🗓️ Scheduled events — ${formatTargetLabel(input.currentTarget)}`;
  if (input.events.length === 0) {
    return `${heading}\nNo scheduled events found.`;
  }

  const lines = [heading];
  for (const item of input.events.slice(0, MAX_EVENTS_DISPLAYED)) {
    lines.push(formatScheduledEventLine(item, input.scope));
  }
  const hidden = input.events.length - MAX_EVENTS_DISPLAYED;
  if (hidden > 0) lines.push(`…and ${hidden} more.`);
  return limitText(lines.join("\n"), MAX_INTERACTION_RESPONSE_CHARS);
}

function formatScheduledEventLine(
  item: StoredEvent,
  scope: "all" | "current",
): string {
  const target =
    scope === "all" ? ` ${formatEventTarget(item.event.target)}` : "";
  return `- ${inlineCode(item.id)} — ${formatEventSchedule(item.event)}${target}; created by ${formatEventCreator(item.event)}\n  ${formatEventSummary(item.event.text)}`;
}

function formatEventSchedule(event: SandiEvent): string {
  switch (event.type) {
    case "immediate":
      return "immediate";
    case "one-shot":
      return `one-shot ${inlineCode(event.at)}${formatNextRun(new Date(event.at))}`;
    case "periodic":
      return `periodic ${inlineCode(event.schedule)} ${event.timezone}${formatNextRun(nextPeriodicRun(event))}`;
  }
}

function formatEventCreator(event: SandiEvent): string {
  return `${event.createdBy.displayName ?? event.createdBy.username ?? event.createdBy.identityId} (${event.createdBy.identityId})`;
}

function nextPeriodicRun(
  event: Extract<SandiEvent, { type: "periodic" }>,
): Date | null {
  try {
    return new Cron(event.schedule, {
      paused: true,
      timezone: event.timezone,
    }).nextRun();
  } catch {
    return null;
  }
}

function formatNextRun(nextRun: Date | null): string {
  if (!nextRun || !Number.isFinite(nextRun.getTime())) return "";
  const deltaMs = nextRun.getTime() - Date.now();
  if (deltaMs < 0) return `, overdue by ${formatDuration(-deltaMs)}`;
  return `, next in ${formatDuration(deltaMs)}`;
}

function formatDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.round(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatEventSummary(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return limitText(firstLine ?? "[no instructions]", 160);
}

function formatTargetLabel(target: EventTarget | undefined): string {
  if (!target) return "current conversation";
  return target.kind === "thread" ? "this thread" : "this channel";
}

function formatEventTarget(target: EventTarget): string {
  if (target.kind === "thread")
    return `(thread ${inlineCode(target.threadId)})`;
  return `(channel ${inlineCode(target.channelId)})`;
}

function isConversationChannel(
  value: unknown,
): value is ConversationDiscordChannel {
  if (!isRecord(value)) return false;
  if (typeof value["id"] !== "string") return false;
  if (typeof value["guildId"] !== "string") return false;
  if (typeof value["name"] !== "string") return false;
  if (value["parentId"] !== null && typeof value["parentId"] !== "string") {
    return false;
  }
  if (typeof value["send"] !== "function") return false;
  return typeof value["sendTyping"] === "function";
}

function providerFailureMessage(error: ProviderTurnError): string {
  const prefix =
    error.reason === "quota-limit" || error.reason === "rate-limit"
      ? "I hit a ChatGPT/Pi limit while trying to answer that."
      : "I hit a ChatGPT/Pi error while trying to answer that.";
  return `${prefix} The error was: ${inlineCode(error.message)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inlineCode(value: string): string {
  const compact = value.replaceAll("`", "'").replace(/\s+/g, " ").trim();
  return `\`${limitText(compact || "unknown provider error", 300)}\``;
}

function limitText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function setBoundedMapEntry<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

async function sendActivitySignal(input: {
  channelId: string;
  token: string;
  messageId?: string;
  reactOnTypingFailure: boolean;
}): Promise<void> {
  const typingSent = await sendTypingSafely(input.channelId, input.token);
  if (typingSent) return;
  if (!input.reactOnTypingFailure || !input.messageId) return;
  if (input.messageId.startsWith("event:")) return;
  await addActivityFallbackReaction({
    channelId: input.channelId,
    messageId: input.messageId,
    token: input.token,
  });
}

async function sendTypingSafely(
  channelId: string,
  token: string,
): Promise<boolean> {
  const now = Date.now();
  if ((typingCooldowns.get(channelId) ?? 0) > now) return false;
  if (typingInFlight.has(channelId)) return false;
  typingInFlight.add(channelId);
  try {
    const response = await discordTypingRequest(channelId, token);
    if (response.ok) return true;

    const retryAfterMs = response.retryAfterMs ?? TYPING_FALLBACK_COOLDOWN_MS;
    setBoundedMapEntry(
      typingCooldowns,
      channelId,
      Date.now() + retryAfterMs,
      MAX_TYPING_COOLDOWNS,
    );
    log.warn("failed to send typing indicator", {
      channelId,
      status: response.status,
      code: response.code ?? "unknown",
      retryAfterMs,
      error: response.message,
    });
    return false;
  } catch (error) {
    setBoundedMapEntry(
      typingCooldowns,
      channelId,
      Date.now() + TYPING_FALLBACK_COOLDOWN_MS,
      MAX_TYPING_COOLDOWNS,
    );
    log.warn("failed to send typing indicator", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    typingInFlight.delete(channelId);
  }
}

type TypingRequestResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      message: string;
      code?: number;
      retryAfterMs?: number;
    };

async function discordTypingRequest(
  channelId: string,
  token: string,
): Promise<TypingRequestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, TYPING_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/typing`,
      {
        method: "POST",
        headers: {
          authorization: `Bot ${token}`,
        },
        signal: controller.signal,
      },
    );
    if (response.ok) return { ok: true };

    const body = await response.text();
    const parsed = parseDiscordErrorBody(body);
    const result: TypingRequestResult = {
      ok: false,
      status: response.status,
      message: parsed.message ?? (body.slice(0, 300) || response.statusText),
    };
    if (parsed.code !== undefined) result.code = parsed.code;
    const parsedRetryAfterMs = retryAfterMs(parsed.retry_after);
    if (parsedRetryAfterMs !== undefined) {
      result.retryAfterMs = parsedRetryAfterMs;
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function parseDiscordErrorBody(body: string): {
  message?: string;
  code?: number;
  retry_after?: unknown;
} {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return {};
    const result: {
      message?: string;
      code?: number;
      retry_after?: unknown;
    } = {};
    if (typeof parsed["message"] === "string") {
      result.message = parsed["message"];
    }
    if (typeof parsed["code"] === "number") result.code = parsed["code"];
    if ("retry_after" in parsed) result.retry_after = parsed["retry_after"];
    return result;
  } catch {
    return {};
  }
}

function retryAfterMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.ceil(value * 1_000) + 1_000;
}

async function addActivityFallbackReaction(input: {
  channelId: string;
  messageId: string;
  token: string;
}): Promise<void> {
  try {
    const response = await discordOwnReactionRequest({
      ...input,
      emoji: ACTIVITY_FALLBACK_EMOJI,
    });
    if (response.ok) return;
    log.warn("failed to add activity fallback reaction", {
      channelId: input.channelId,
      messageId: input.messageId,
      status: response.status,
      code: response.code ?? "unknown",
      error: response.message,
    });
  } catch (error) {
    log.warn("failed to add activity fallback reaction", {
      channelId: input.channelId,
      messageId: input.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type DiscordRequestResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      message: string;
      code?: number;
    };

async function discordOwnReactionRequest(input: {
  channelId: string;
  messageId: string;
  emoji: string;
  token: string;
}): Promise<DiscordRequestResult> {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${input.channelId}/messages/${input.messageId}/reactions/${encodeURIComponent(input.emoji)}/@me`,
    {
      method: "PUT",
      headers: {
        authorization: `Bot ${input.token}`,
      },
    },
  );
  if (response.ok) return { ok: true };

  const body = await response.text();
  const parsed = parseDiscordErrorBody(body);
  const result: DiscordRequestResult = {
    ok: false,
    status: response.status,
    message: parsed.message ?? (body.slice(0, 300) || response.statusText),
  };
  if (parsed.code !== undefined) result.code = parsed.code;
  return result;
}

async function sendThreadCreationFailureNotice(
  message: Message,
  error: unknown,
): Promise<void> {
  if (!message.channel.isSendable()) return;
  try {
    await message.reply({
      content: `I couldn't start a thread for that Sandi turn, so I didn't run it. ${inlineCode(errorMessage(error))}`,
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch (noticeError) {
    log.error("failed to send Sandi thread creation failure notice", {
      messageId: message.id,
      error: errorMessage(noticeError),
    });
  }
}

function participantFromMessage(message: Message): ConversationParticipant {
  const displayName = usernameFor(message.member, message.author.username);
  return {
    platform: "discord",
    platformUserId: message.author.id,
    username: message.author.username,
    displayName,
    joinedAt: new Date().toISOString(),
  };
}

function eventAuthor(event: SandiEvent): ConversationParticipant {
  return {
    platform: "discord",
    platformUserId: event.createdBy.discordUserId,
    username:
      event.createdBy.username ?? event.createdBy.displayName ?? "EVENT",
    ...(event.createdBy.displayName
      ? { displayName: event.createdBy.displayName }
      : {}),
    identityId: event.createdBy.identityId,
    joinedAt: event.createdAt,
  };
}

function accountRoutingForPersistentTurn(
  author: ConversationParticipant,
): PiAccountRoutingRequest {
  const request: PiAccountRoutingRequest = {};
  if (author.identityId) request.identityId = author.identityId;
  return request;
}

function accountRoutingForOneOffTurn(
  author: ConversationParticipant,
): PiAccountRoutingRequest {
  const request: PiAccountRoutingRequest = {};
  if (author.identityId) request.identityId = author.identityId;
  return request;
}

function usernameFor(member: GuildMember | null, fallback: string): string {
  return member?.displayName ?? fallback;
}

function stripBotMention(content: string, botId: string | undefined): string {
  if (!botId) return content.trim();
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

function formatUserTurn(
  author: ConversationParticipant,
  input: string,
  metadata: string,
): string {
  return [
    `<discord_message author="${author.username}" discord_user_id="${author.platformUserId}">`,
    "<metadata>",
    ...accountRoutingProvenanceLines({
      source: "discord_message_author",
      discordUserId: author.platformUserId,
      username: author.username,
      displayName: author.displayName,
      identityId: author.identityId,
    }),
    metadata,
    "</metadata>",
    "",
    input,
    "</discord_message>",
  ].join("\n");
}

function formatEventTurn(trigger: EventTrigger): string {
  return [
    `<scheduled_event event_id="${trigger.id}" event_type="${trigger.event.type}">`,
    trigger.label,
    "",
    "<event_guide>",
    "You are being triggered by Sandi's temporal continuity system. Carry out the event instructions in this Discord conversation target. If the action is unclear or no longer appropriate, say so briefly instead of forcing it.",
    "</event_guide>",
    "",
    "<instructions>",
    trigger.event.text,
    "</instructions>",
    "</scheduled_event>",
  ].join("\n");
}

function eventMetadata(
  trigger: EventTrigger,
  channel: ConversationDiscordChannel,
): string {
  const lines = [
    `time: ${new Date().toISOString()}`,
    `event_id: ${trigger.id}`,
    `event_type: ${trigger.event.type}`,
    `event_label: ${trigger.label}`,
    `event_created_at: ${trigger.event.createdAt}`,
    `event_created_by_discord_user_id: ${trigger.event.createdBy.discordUserId}`,
    `event_created_by_identity_id: ${trigger.event.createdBy.identityId}`,
    `event_created_by_username: ${trigger.event.createdBy.username ?? "unknown"}`,
    ...accountRoutingProvenanceLines({
      source: "scheduled_event_creator",
      discordUserId: trigger.event.createdBy.discordUserId,
      username: trigger.event.createdBy.username,
      displayName: trigger.event.createdBy.displayName,
      identityId: trigger.event.createdBy.identityId,
    }),
    `event_target_kind: ${trigger.event.target.kind}`,
    `guild_id: ${channel.guildId}`,
    `channel_id: ${channel.id}`,
    `channel_name: ${channel.name}`,
    `parent_channel_id: ${channel.parentId ?? "none"}`,
    ...channelTopicMetadata(channel),
  ];
  if (trigger.event.type === "one-shot") {
    lines.push(`event_at: ${trigger.event.at}`);
  }
  if (trigger.event.type === "periodic") {
    lines.push(`event_schedule: ${trigger.event.schedule}`);
    lines.push(`event_timezone: ${trigger.event.timezone}`);
  }
  return lines.join("\n");
}

function accountRoutingProvenanceLines(input: {
  source: "discord_message_author" | "scheduled_event_creator";
  discordUserId: string;
  username: string | undefined;
  displayName: string | undefined;
  identityId: string | undefined;
}): string[] {
  return [
    "account_routing_policy: per-human ChatGPT/Codex account routing",
    `account_routing_source: ${input.source}`,
    `account_routing_discord_user_id: ${input.discordUserId}`,
    `account_routing_identity_id: ${input.identityId ?? "unmapped_fail_closed"}`,
    `account_routing_username: ${input.username ?? "unknown"}`,
    `account_routing_display_name: ${input.displayName ?? input.username ?? "unknown"}`,
  ];
}

async function messageMetadata(message: Message): Promise<string> {
  const lines = [
    `time: ${message.createdAt.toISOString()}`,
    `message_id: ${message.id}`,
    `message_url: ${message.url}`,
    `guild_id: ${message.guildId ?? "dm"}`,
    `guild_name: ${message.guild?.name ?? "dm"}`,
    `channel_id: ${message.channelId}`,
    `channel_name: ${channelName(message)}`,
    `channel_type: ${message.channel.type}`,
    ...channelTopicMetadata(message.channel),
    `user_id: ${message.author.id}`,
    `username: ${message.author.username}`,
    `display_name: ${message.member?.displayName ?? message.author.username}`,
  ];
  const [referenced, recentThreadContext] = await Promise.all([
    referencedMessageMetadata(message),
    recentThreadContextMetadata(message),
  ]);
  if (message.attachments.size > 0) {
    lines.push("", "attachments:");
    for (const attachment of message.attachments.values()) {
      lines.push(
        `  - id: ${attachment.id}`,
        `    filename: ${attachment.name}`,
        `    content_type: ${attachment.contentType ?? "unknown"}`,
        `    size: ${attachment.size}`,
        `    url: ${attachment.url}`,
      );
      if (attachment.width && attachment.height) {
        lines.push(`    dimensions: ${attachment.width}x${attachment.height}`);
      }
    }
  }
  if (referenced) lines.push("", referenced);
  if (recentThreadContext) lines.push("", recentThreadContext);
  return lines.join("\n");
}

async function messageThreadStarterMetadata(input: {
  originMessage: Message;
  thread: AnyThreadChannel;
}): Promise<string> {
  return [
    await messageMetadata(input.originMessage),
    "",
    "sandi_message_thread:",
    "  note: This top-level Discord message created the current Sandi-managed thread conversation.",
    `  thread_id: ${input.thread.id}`,
    `  thread_name: ${input.thread.name}`,
    `  parent_channel_id: ${input.thread.parentId ?? input.originMessage.channelId}`,
    `  origin_message_id: ${input.originMessage.id}`,
    `  origin_message_url: ${input.originMessage.url}`,
  ].join("\n");
}

async function recentThreadContextMetadata(
  trigger: Message,
): Promise<string | undefined> {
  const thread = asThread(trigger.channel);
  if (!thread) return undefined;

  try {
    const messages = await thread.messages.fetch({
      limit: RECENT_THREAD_CONTEXT_FETCH_LIMIT,
      before: trigger.id,
    });
    const botId = trigger.client.user?.id;
    const sorted = [...messages.values()].sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp,
    );
    const lastBotMessage = botId
      ? sorted.find((message) => message.author.id === botId)
      : undefined;
    const sinceLastBot = sorted.filter((message) => {
      if (message.author.id === botId) return false;
      return lastBotMessage
        ? message.createdTimestamp > lastBotMessage.createdTimestamp
        : true;
    });
    const recent = sinceLastBot
      .slice(0, RECENT_THREAD_CONTEXT_DISPLAY_LIMIT)
      .reverse();
    if (recent.length === 0) return undefined;

    const lines = [
      "recent_thread_context:",
      "  note: Recent Discord thread messages before this trigger, included only as continuity context.",
    ];
    for (const message of recent) {
      lines.push(formatRecentThreadMessage(message));
    }
    return lines.join("\n");
  } catch {
    return undefined;
  }
}

function formatRecentThreadMessage(message: Message): string {
  const displayName = message.member?.displayName ?? message.author.username;
  const content = recentThreadMessageContent(message);
  return `  - time: ${message.createdAt.toISOString()} | user: ${displayName} (${message.author.id}) | content: ${content}`;
}

function recentThreadMessageContent(message: Message): string {
  const parts: string[] = [];
  const text = message.content.replace(/\s+/g, " ").trim();
  if (text) parts.push(text);
  if (message.attachments.size > 0) {
    const names = [...message.attachments.values()]
      .map((attachment) => attachment.name)
      .filter((name) => name.length > 0);
    parts.push(
      names.length > 0
        ? `[attachments: ${names.join(", ")}]`
        : `[${message.attachments.size} attachment(s)]`,
    );
  }
  return limitText(
    parts.join(" ") || "[no text content]",
    RECENT_THREAD_MESSAGE_MAX_LENGTH,
  );
}

async function passiveReplyGateInput(
  message: Message,
  botName: string | undefined,
): Promise<string> {
  const [recentMessages, repliedTo] = await Promise.all([
    recentChannelContextForGate(message),
    referencedGateMessage(message),
  ]);
  return passiveReplyGateRequestInput({
    sandiName: botName ?? "Sandi",
    channelName: channelName(message),
    author: {
      username: message.author.username,
      displayName: message.member?.displayName ?? message.author.username,
    },
    message: recentThreadMessageContent(message),
    ...(repliedTo ? { repliedTo } : {}),
    recentMessages,
  });
}

async function recentChannelContextForGate(
  message: Message,
): Promise<PassiveReplyGateContextMessage[]> {
  try {
    const fetched = await message.channel.messages.fetch({
      limit: PASSIVE_GATE_CONTEXT_FETCH_LIMIT,
      before: message.id,
    });
    return [...fetched.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-PASSIVE_GATE_CONTEXT_DISPLAY_LIMIT)
      .map((recent) => gateContextMessage(recent));
  } catch {
    return [];
  }
}

async function referencedGateMessage(
  message: Message,
): Promise<PassiveReplyGateContextMessage | undefined> {
  const referencedId = message.reference?.messageId;
  if (!referencedId) return undefined;
  try {
    const referenced = await message.channel.messages.fetch(referencedId);
    return gateContextMessage(referenced);
  } catch {
    return undefined;
  }
}

function gateContextMessage(message: Message): PassiveReplyGateContextMessage {
  return {
    author: message.member?.displayName ?? message.author.username,
    content: recentThreadMessageContent(message),
  };
}

async function referencedMessageMetadata(
  message: Message,
): Promise<string | undefined> {
  const referencedId = message.reference?.messageId;
  if (!referencedId) return undefined;
  try {
    const referenced = await message.channel.messages.fetch(referencedId);
    return [
      "referenced_message:",
      `  time: ${referenced.createdAt.toISOString()}`,
      `  message_id: ${referenced.id}`,
      `  user_id: ${referenced.author.id}`,
      `  username: ${referenced.author.username}`,
      `  content: ${referenced.content || "[no text content]"}`,
      ...referencedAttachmentMetadata(referenced),
    ].join("\n");
  } catch {
    return `referenced_message: ${referencedId} (could not fetch)`;
  }
}

function referencedAttachmentMetadata(message: Message): string[] {
  if (message.attachments.size === 0) return [];
  const lines = ["  attachments:"];
  for (const attachment of message.attachments.values()) {
    lines.push(
      `    - id: ${attachment.id}`,
      `      filename: ${attachment.name}`,
      `      content_type: ${attachment.contentType ?? "unknown"}`,
      `      size: ${attachment.size}`,
      `      url: ${attachment.url}`,
    );
    if (attachment.width && attachment.height) {
      lines.push(`      dimensions: ${attachment.width}x${attachment.height}`);
    }
  }
  return lines;
}

function channelName(message: Message): string {
  return "name" in message.channel
    ? (message.channel.name ?? "unknown")
    : "unknown";
}

function channelTopicMetadata(channel: unknown): string[] {
  const lines: string[] = [];
  const topic = channelTopic(channel);
  if (topic) lines.push(`channel_topic: ${topic}`);

  const parent = isRecord(channel) ? channel["parent"] : undefined;
  const parentTopic = channelTopic(parent);
  if (parentTopic) lines.push(`parent_channel_topic: ${parentTopic}`);

  return lines;
}

function channelTopic(channel: unknown): string | undefined {
  if (!isRecord(channel)) return undefined;
  const topic = channel["topic"];
  if (typeof topic !== "string") return undefined;
  const compact = topic.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return limitText(compact, 500);
}

function toolContextFromMessage(
  message: Message,
  author?: ConversationParticipant,
): DiscordToolContext {
  const thread = asThread(message.channel);
  const context: DiscordToolContext = {
    platform: "discord",
    channelId: message.channelId,
    messageId: message.id,
  };
  if (author) context.author = toolContextAuthor(author);
  if (message.guildId) context.guildId = message.guildId;
  if (thread) {
    context.threadId = thread.id;
    if (thread.parentId) context.parentChannelId = thread.parentId;
  }
  return context;
}

function toolContextFromThreadStarter(input: {
  originMessage: Message;
  thread: AnyThreadChannel;
  author?: ConversationParticipant;
}): DiscordToolContext {
  const context: DiscordToolContext = {
    platform: "discord",
    channelId: input.thread.id,
    messageId: input.originMessage.id,
    threadId: input.thread.id,
  };
  const guildId = input.originMessage.guildId ?? input.thread.guildId;
  if (guildId) context.guildId = guildId;
  const parentChannelId =
    input.thread.parentId ?? input.originMessage.channelId;
  if (parentChannelId) context.parentChannelId = parentChannelId;
  if (input.author) context.author = toolContextAuthor(input.author);
  return context;
}

function toolContextFromChannel(
  channel: ConversationDiscordChannel,
  eventId: string,
  author?: ConversationParticipant,
): DiscordToolContext {
  const context: DiscordToolContext = {
    platform: "discord",
    guildId: channel.guildId,
    channelId: channel.id,
    messageId: `event:${eventId}`,
  };
  if (author) context.author = toolContextAuthor(author);
  if (channel.isThread?.()) {
    context.threadId = channel.id;
    if (channel.parentId) context.parentChannelId = channel.parentId;
  }
  return context;
}

function toolContextAuthor(
  participant: ConversationParticipant,
): NonNullable<DiscordToolContext["author"]> {
  const author = {
    discordUserId: participant.platformUserId,
    username: participant.username,
  };
  return {
    ...author,
    ...(participant.displayName
      ? { displayName: participant.displayName }
      : {}),
    ...(participant.identityId ? { identityId: participant.identityId } : {}),
  };
}

function estimatePromptTokens(text: string): number {
  const wordsAndSymbols = text.match(/\p{L}+|\p{N}+|[^\s\p{L}\p{N}]/gu) ?? [];
  const byteAdjustment = Math.ceil(Buffer.byteLength(text, "utf8") / 12);
  return Math.max(1, Math.ceil(wordsAndSymbols.length * 0.75 + byteAdjustment));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

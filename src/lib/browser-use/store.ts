import { JsonFileStore } from "../state/file-store";
import {
  type AwaitingHumanSession,
  type BrowserProfile,
  type BrowserSession,
  BrowserSessionSchema,
  type BrowserUseState,
  BrowserUseStateSchema,
  EMPTY_BROWSER_USE_STATE,
  isOpenBrowserSession,
} from "./state";

export class BrowserUseStore {
  readonly #store: JsonFileStore<BrowserUseState>;

  constructor(path: string) {
    this.#store = new JsonFileStore(path, BrowserUseStateSchema);
  }

  read(): Promise<BrowserUseState> {
    return this.#store.read(EMPTY_BROWSER_USE_STATE);
  }

  async findProfile(
    identityId: string,
    alias: string,
  ): Promise<BrowserProfile | undefined> {
    const state = await this.read();
    return state.profiles.find(
      (profile) => profile.identityId === identityId && profile.alias === alias,
    );
  }

  async saveProfile(profile: BrowserProfile): Promise<void> {
    await this.#store.updateManaged((state) => {
      const profiles = state.profiles.filter(
        (current) =>
          current.identityId !== profile.identityId ||
          current.alias !== profile.alias,
      );
      return { ...state, profiles: [...profiles, profile] };
    }, EMPTY_BROWSER_USE_STATE);
  }

  async saveSession(session: BrowserSession): Promise<void> {
    await this.#store.updateManaged((state) => {
      const sessions = state.sessions.filter(
        (current) => current.id !== session.id,
      );
      return { ...state, sessions: [...sessions, session] };
    }, EMPTY_BROWSER_USE_STATE);
  }

  async updateSession(
    id: string,
    mutate: (session: BrowserSession) => BrowserSession,
  ): Promise<BrowserSession> {
    let updated: BrowserSession | undefined;
    await this.#store.updateManaged((state) => {
      const sessions = state.sessions.map((session) => {
        if (session.id !== id) return session;
        updated = BrowserSessionSchema.parse(mutate(session));
        return updated;
      });
      if (!updated) throw new Error(`Browser session ${id} was not found`);
      return { ...state, sessions };
    }, EMPTY_BROWSER_USE_STATE);
    if (!updated) throw new Error(`Browser session ${id} was not found`);
    return updated;
  }

  async requireOwnedSession(
    id: string,
    identityId: string,
  ): Promise<BrowserSession> {
    const state = await this.read();
    const session = state.sessions.find((current) => current.id === id);
    if (!session || session.identityId !== identityId) {
      throw new Error("Browser session was not found for this identity");
    }
    return session;
  }

  async openSessions(identityId?: string): Promise<BrowserSession[]> {
    const state = await this.read();
    return state.sessions.filter(
      (session) =>
        isOpenBrowserSession(session) &&
        (identityId === undefined || session.identityId === identityId),
    );
  }

  async pendingDiscordHandoffs(
    conversationId: string,
  ): Promise<AwaitingHumanSession[]> {
    const state = await this.read();
    return state.sessions.filter(
      (session): session is AwaitingHumanSession =>
        session.state === "awaiting-human" &&
        session.conversationId === conversationId &&
        session.handoff.promptMessageId === undefined,
    );
  }
}

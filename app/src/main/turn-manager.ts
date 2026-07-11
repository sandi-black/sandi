import type {
  QueuedTurnSummary,
  QueueState,
  TurnSettledEvent,
} from "@shared/ipc-contract";

import type { TurnOutcome } from "@sandi-server/surfaces/api/client/turns";

// Per-conversation turn queue. The server already serializes concurrent turn
// POSTs per conversation, so this client-side queue exists for the UI: queued
// messages show as chips the instant they are submitted, can be cancelled
// before they send, and the app never holds N open sockets against one
// conversation just to wait in the server's line.

export type SendTurnFn = (input: {
  conversationId: string;
  text: string;
  turnId: string;
  attachmentIds: string[];
  signal: AbortSignal;
}) => Promise<TurnOutcome>;

export type TurnManagerEvents = {
  // Fired when a queued turn actually starts sending (its deltas may follow).
  onTurnStarted(event: { conversationId: string; turnId: string }): void;
  onTurnSettled(event: TurnSettledEvent): void;
  onQueueState(state: QueueState): void;
};

type QueuedTurn = QueuedTurnSummary & {
  conversationId: string;
  attachmentIds: string[];
};

type ConversationQueue = {
  inflight?: { turnId: string; controller: AbortController };
  pending: QueuedTurn[];
};

export type TurnManager = {
  submit(input: {
    conversationId: string;
    text: string;
    turnId: string;
    attachmentIds: string[];
  }): void;
  // Aborts the in-flight turn (closing its socket aborts the pi child
  // server-side). Queued turns behind it still run.
  stop(turnId: string): void;
  // Removes a not-yet-started turn from the queue.
  cancelQueued(turnId: string): void;
  queueState(conversationId: string): QueueState;
};

export function createTurnManager(input: {
  sendTurn: SendTurnFn;
  events: TurnManagerEvents;
}): TurnManager {
  const queues = new Map<string, ConversationQueue>();

  const queueFor = (conversationId: string): ConversationQueue => {
    let queue = queues.get(conversationId);
    if (!queue) {
      queue = { pending: [] };
      queues.set(conversationId, queue);
    }
    return queue;
  };

  const emitQueueState = (conversationId: string): void => {
    input.events.onQueueState(stateOf(conversationId, queues));
  };

  const drain = (conversationId: string): void => {
    const queue = queueFor(conversationId);
    if (queue.inflight) return;
    const next = queue.pending.shift();
    if (!next) {
      emitQueueState(conversationId);
      queues.delete(conversationId);
      return;
    }
    const controller = new AbortController();
    queue.inflight = { turnId: next.turnId, controller };
    emitQueueState(conversationId);
    input.events.onTurnStarted({ conversationId, turnId: next.turnId });
    const settle = (turnId: string, outcome: TurnOutcome): void => {
      delete queue.inflight;
      if (outcome.ok) {
        input.events.onTurnSettled({
          turnId,
          conversationId,
          ok: true,
          text: outcome.text,
        });
      } else {
        input.events.onTurnSettled({
          turnId,
          conversationId,
          ok: false,
          error: controller.signal.aborted ? "stopped" : outcome.error,
        });
      }
      drain(conversationId);
    };

    let pending: Promise<TurnOutcome>;
    try {
      pending = input.sendTurn({
        conversationId,
        text: next.text,
        turnId: next.turnId,
        attachmentIds: next.attachmentIds,
        signal: controller.signal,
      });
    } catch (error) {
      // A transport is expected to return a rejected promise, but a
      // synchronous throw must not wedge every later turn in the queue.
      settle(next.turnId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    void pending
      .then((outcome) => {
        settle(next.turnId, outcome);
      })
      .catch((error: unknown) => {
        settle(next.turnId, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  return {
    submit({ conversationId, text, turnId, attachmentIds }) {
      const queue = queueFor(conversationId);
      queue.pending.push({ conversationId, turnId, text, attachmentIds });
      drain(conversationId);
      // drain emits queue state when it starts a turn; a submit that only
      // queued (something already inflight) still needs the chip to appear.
      emitQueueState(conversationId);
    },
    stop(turnId) {
      for (const queue of queues.values()) {
        if (queue.inflight?.turnId === turnId) {
          queue.inflight.controller.abort();
          return;
        }
      }
    },
    cancelQueued(turnId) {
      for (const [conversationId, queue] of queues.entries()) {
        const index = queue.pending.findIndex(
          (candidate) => candidate.turnId === turnId,
        );
        if (index >= 0) {
          queue.pending.splice(index, 1);
          emitQueueState(conversationId);
          if (!queue.inflight && queue.pending.length === 0) {
            queues.delete(conversationId);
          }
          return;
        }
      }
    },
    queueState(conversationId) {
      return stateOf(conversationId, queues);
    },
  };
}

function stateOf(
  conversationId: string,
  queues: Map<string, ConversationQueue>,
): QueueState {
  const queue = queues.get(conversationId);
  const state: QueueState = {
    conversationId,
    pending: (queue?.pending ?? []).map(({ turnId, text }) => ({
      turnId,
      text,
    })),
  };
  if (queue?.inflight) state.inflightTurnId = queue.inflight.turnId;
  return state;
}

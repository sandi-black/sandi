import type { JSX } from "react";

import { useChatStore } from "./store";
import { AnimatePresence, motion } from "motion/react";

// Slide-in session list. The popover is narrow, so sessions live in a drawer
// over the transcript rather than a permanent sidebar.

export function SessionDrawer({
  onSelect,
  onCreate,
  onDelete,
}: {
  onSelect(conversationId: string): void;
  onCreate(): void;
  onDelete(conversationId: string): void;
}): JSX.Element {
  const open = useChatStore((state) => state.drawerOpen);
  const setOpen = useChatStore((state) => state.setDrawerOpen);
  const sessions = useChatStore((state) => state.sessions);
  const active = useChatStore((state) => state.activeConversationId);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="drawer-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setOpen(false)}
          />
          <motion.aside
            className="drawer"
            initial={{ x: -280 }}
            animate={{ x: 0 }}
            exit={{ x: -280 }}
            transition={{ type: "spring", stiffness: 400, damping: 34 }}
          >
            <div className="drawer-header">
              <span>Conversations</span>
              <button
                type="button"
                className="icon-button"
                title="Close"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>
            <button type="button" className="new-session" onClick={onCreate}>
              ✦ New conversation
            </button>
            <div className="session-list">
              {sessions.map((session) => (
                <div
                  key={session.conversationId}
                  className={`session-row${
                    session.conversationId === active ? " active" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="session-select"
                    onClick={() => onSelect(session.conversationId)}
                  >
                    <span className="session-title">{session.title}</span>
                    {session.lastPreview && (
                      <span className="session-preview">
                        {session.lastPreview}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="session-delete"
                    title="Delete conversation"
                    onClick={() => onDelete(session.conversationId)}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

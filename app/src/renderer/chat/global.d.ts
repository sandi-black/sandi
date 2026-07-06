import type { SandiChatBridge } from "@shared/ipc-contract";

declare global {
  interface Window {
    sandiChat: SandiChatBridge;
  }
}

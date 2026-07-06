import type { PetDisplayEvent, SandiPetBridge } from "@shared/ipc-contract";
import { IPC } from "@shared/ipc-contract";
import { contextBridge, ipcRenderer } from "electron";

// The pet window's bridge: dragging, click-through toggling, and the display
// event stream. Deliberately tiny; the pet has no business near sessions,
// turns, or credentials.

const bridge: SandiPetBridge = {
  dragStart(cursor) {
    ipcRenderer.send(IPC.petDragStart, cursor);
  },
  dragMove(cursor) {
    ipcRenderer.send(IPC.petDragMove, cursor);
  },
  dragEnd() {
    ipcRenderer.send(IPC.petDragEnd);
  },
  openChat() {
    ipcRenderer.send(IPC.petOpenChat);
  },
  setIgnoreMouseEvents(ignore) {
    ipcRenderer.send(IPC.petSetIgnoreMouse, ignore);
  },
  onDisplayEvent(listener) {
    const handler = (_event: unknown, payload: PetDisplayEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC.petDisplayEvent, handler);
    return () => ipcRenderer.removeListener(IPC.petDisplayEvent, handler);
  },
};

contextBridge.exposeInMainWorld("sandiPet", bridge);

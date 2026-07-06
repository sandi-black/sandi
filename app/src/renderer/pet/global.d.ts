import type { SandiPetBridge } from "@shared/ipc-contract";

declare global {
  interface Window {
    sandiPet: SandiPetBridge;
  }
}

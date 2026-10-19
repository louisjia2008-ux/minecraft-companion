import type { DeskPetApi } from '../shared/contracts';

declare global {
  interface Window {
    deskpet: DeskPetApi;
  }
}

export {};

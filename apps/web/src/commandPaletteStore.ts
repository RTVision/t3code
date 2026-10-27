import { useEffect } from "react";
import { create } from "zustand";

import {
  type CommandPaletteUiAction,
  type CommandPaletteUiState,
  reduceCommandPaletteUiState,
} from "./components/CommandPalette.logic";
import { rememberVimOverlayFocus } from "./vim/runtime";

const INITIAL_STATE: CommandPaletteUiState = {
  open: false,
  mode: "command",
  openIntent: null,
  session: 0,
};

export const useCommandPaletteStore = create<CommandPaletteUiState>(() => INITIAL_STATE);

export function dispatchCommandPalette(action: CommandPaletteUiAction): void {
  const state = useCommandPaletteStore.getState();
  const next = reduceCommandPaletteUiState(state, action);
  // Vim returns focus to the pane that held it once the palette closes.
  if (!state.open && next.open) rememberVimOverlayFocus();
  useCommandPaletteStore.setState(next, true);
}

// The palette is only mounted on app-shell routes (not /pair, sign-in or
// landings), so its shortcuts must stay inert elsewhere.
let mountedPalettes = 0;

export function isCommandPaletteMounted(): boolean {
  return mountedPalettes > 0;
}

/**
 * Marks the palette as mounted while the calling component is. An unmounted
 * palette cannot stay open, so the last unmount resets the store.
 */
export function useCommandPaletteMount(): void {
  // oxlint-disable-next-line t3code/react-effect-budget -- The palette's mount gates its global shortcuts, and leaving the route while it is open calls no close handler, so only unmount can reset the store.
  useEffect(() => {
    mountedPalettes += 1;
    return () => {
      mountedPalettes -= 1;
      if (mountedPalettes === 0) {
        useCommandPaletteStore.setState(
          (state) => ({ ...INITIAL_STATE, session: state.session + 1 }),
          true,
        );
      }
    };
  }, []);
}

import type { KeybindingCommand } from "@t3tools/contracts";

import { dispatchCommand } from "../shortcuts/dispatcher";

type CommandListener = (event: KeyboardEvent, command: KeybindingCommand) => void;
const listeners = new Set<CommandListener>();

/** UI command dispatch shares the same handlers as ordinary shortcuts. */
export function onAppCommand(listener: CommandListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function dispatchAppCommand(command: KeybindingCommand, event: KeyboardEvent): void {
  if (dispatchCommand(command, event)) return;
  for (const listener of listeners) listener(event, command);
}

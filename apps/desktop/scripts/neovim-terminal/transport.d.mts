import type { EditorOpenTarget } from "@t3tools/contracts";
export type TerminalRoute =
  | { kind: "native" }
  | { kind: "wsl"; distro: string; user: string; node?: string }
  | { kind: "ssh"; host: string; sshUser?: string; port?: number; remoteNode?: string }
  | {
      kind: "wsl-ssh";
      distro: string;
      user: string;
      node?: string;
      host: string;
      sshUser?: string;
      port?: number;
      remoteNode?: string;
    };
export interface LaunchPayload {
  version: 1;
  id: string;
  platform: string;
  route: TerminalRoute;
  workspace: string;
  target: EditorOpenTarget;
  executable?: string;
  expectedAccount?: string;
}
export function encodeRequest(input: LaunchPayload): string;
export function decodeRequest(token: string): LaunchPayload;
export function quotePosix(value: string): string;
export function windowsTerminalArgs(input: {
  powershell: string;
  bootstrap: string;
  runtime: string;
  token: string;
}): string[];
export function sshArgs(
  route: Extract<TerminalRoute, { kind: "ssh" | "wsl-ssh" }>,
  tty: boolean,
): string[];
export function wslArgs(route: Extract<TerminalRoute, { kind: "wsl" | "wsl-ssh" }>): string[];
export function run(
  command: string,
  args: readonly string[],
  options?: {
    input?: string;
    timeout?: number;
    cwd?: string;
    capture?: boolean;
    env?: NodeJS.ProcessEnv;
  },
): Promise<string>;
export function findNeovim(override?: string, environment?: NodeJS.ProcessEnv): Promise<string>;
export function neovimArgs(target: EditorOpenTarget): Promise<string[]>;

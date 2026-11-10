export type TerminalInfo = Readonly<{
  id: string;
  title: string;
  shell: Readonly<{path: string; name: string; args: readonly string[]}>;
  cwd: string;
  cols: number;
  rows: number;
  state: 'running' | 'exited' | 'failed';
  exitCode: number | null;
}>;
export type TerminalInventory = Readonly<{
  protocol: 1;
  session_id: string;
  terminals: readonly TerminalInfo[];
  execution_authorized: false;
}>;
export function projectTerminalInventory(sessionId: string, terminals: unknown): TerminalInventory;
export function validateTerminalInventory(value: unknown, sessionId: string): TerminalInventory;

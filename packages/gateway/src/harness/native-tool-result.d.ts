export interface PublicNativeToolResult {
  failed: boolean;
  evidence: null | {
    browse_outcome: 'success' | 'pause' | 'failure' | 'unknown';
    action_trace_count: number;
    traced_action_types?: string[];
    verification_statuses?: string[];
    verified_action_types: string[];
  };
}
export function publicNativeToolResult(data: Record<string, unknown>, includeBrowse?: boolean): PublicNativeToolResult;
export function parsePublicNativeToolResult(value: unknown): PublicNativeToolResult;
export function sessionToolCallId(data: Record<string, unknown>): unknown;
export function nativeBatchWebCall(data: Record<string, unknown>): {name: 'universe_read_page' | 'universe_browse' | 'universe_execute'} | null;

export type NativeArtifactReceipt=import('../../contracts/types.js').ActivityResultArtifact;
export function collectArtifactRefs(value: unknown, output?: Set<string>, receipts?: Map<string,NativeArtifactReceipt>): void;
export interface PublicNativeToolResult {
  artifact_receipts?: NativeArtifactReceipt[];
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

export interface PublicNativeToolCall {
  query_count: number;
  urls: string[];
  requested_action_types: string[];
  delegates: boolean;
  action?: string;
  native_batch_web?: 'universe_read_page' | 'universe_browse' | 'universe_execute';
}
export function publicNativeToolCall(data: Record<string, unknown>): PublicNativeToolCall;
export function parsePublicNativeToolCall(value: unknown): PublicNativeToolCall;
export function safeWebOperationUrl(value: unknown): string | null;

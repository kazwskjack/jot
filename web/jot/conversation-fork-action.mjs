import {createElement} from 'react';
import {isKnownNoEffectConversationForkError} from './conversation-fork-controller.mjs';

const activeWriters = new WeakSet();
const UNKNOWN_RESULT = '副本状态未确认；可以重试原请求。';
const WRONG_BOUNDARY = '待重试请求绑定了另一条来源边界；请回到原消息重试。';
const NO_EFFECT_MESSAGES = new Map([
  ['FORK_SOURCE_CHANGED', '来源对话已变化；请刷新后重新选择消息。'],
  ['FORK_BOUNDARY_NOT_FOUND', '选中的消息已不存在；请刷新后重新选择消息。'],
  ['FORK_ATTACHMENT_COUNT_INVALID', '副本附件数量超过限制；请选择更早的消息边界后重试。'],
  ['FORK_ATTACHMENT_AGGREGATE_SIZE_INVALID', '副本附件总大小超过限制；请选择更早的消息边界后重试。']
]);
const REFRESH_BOUNDARY_CODES = new Set(['FORK_SOURCE_CHANGED','FORK_BOUNDARY_NOT_FOUND']);

function matchesSelection(selection, source, message) {
  return Boolean(selection)
    && selection.sourceConversationId === source?.conversation_id
    && selection.expectedVersion === source?.version
    && selection.throughMessageId === message?.message_id;
}

function matchesReceipt(receipt, selection) {
  return Boolean(receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && typeof receipt.conversation_id === 'string' && receipt.conversation_id
    && receipt.conversation_id !== selection.sourceConversationId
    && typeof receipt.fork_id === 'string' && receipt.fork_id
    && receipt.state === 'ready'
    && receipt.source?.conversation_id === selection.sourceConversationId
    && receipt.source?.through_message_id === selection.throughMessageId
    && typeof receipt.source?.head_sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(receipt.source.head_sha256));
}

/** Standalone Jot action. It is intentionally not mounted by shared entry points. */
/** @param {{source?:Pick<import('./types').Conversation,'conversation_id'|'version'>|null,message:Pick<import('./types').Message,'message_id'|'status'>,writer:import('./conversation-fork-controller.mjs').ConversationForkWriter,busy?:boolean,onOpenConversation?:(target:string,receipt:import('../../packages/gateway/contracts/types').ConversationForkReceipt)=>void,onStateChange?:(state:{state:string,retryable:boolean,error:string})=>void,onNoEffect?:()=>void}} props */
export function ConversationForkAction({source, message, writer, busy = false, onOpenConversation, onStateChange = () => {}, onNoEffect = () => {}}) {
  const complete = message?.status === 'complete';
  const retry = Boolean(writer?.pending);
  const canRun = complete && !busy && writer && typeof writer.fork === 'function'
    && typeof writer.retry === 'function' && typeof onOpenConversation === 'function';

  const activate = async () => {
    if (!canRun || activeWriters.has(writer)) return;
    activeWriters.add(writer);
    try {
      const selection = retry ? writer.pendingSelection : {
        sourceConversationId: source?.conversation_id,
        expectedVersion: source?.version,
        throughMessageId: message?.message_id
      };
      if (!matchesSelection(selection, source, message)) {
        onStateChange({state: 'retryable', retryable: true, error: WRONG_BOUNDARY});
        return;
      }

      onStateChange({state: 'submitting', retryable: retry, error: ''});
      let receipt;
      try {
        receipt = retry ? await writer.retry() : await writer.fork(source, message);
      } catch (error) {
        const stillPending = Boolean(writer.pending);
        const noEffect = !stillPending && isKnownNoEffectConversationForkError(error) ? NO_EFFECT_MESSAGES.get(error?.message) : undefined;
        onStateChange({state: stillPending ? 'retryable' : 'failed', retryable: stillPending, error: noEffect ?? UNKNOWN_RESULT});
        if (noEffect && REFRESH_BOUNDARY_CODES.has(error?.message)) {
          try { await onNoEffect(); } catch {}
        }
        return;
      }

      if (!matchesReceipt(receipt, selection)) {
        onStateChange({state: writer.pending ? 'retryable' : 'failed', retryable: Boolean(writer.pending), error: UNKNOWN_RESULT});
        return;
      }
      onStateChange({state: 'ready', retryable: false, error: ''});
      onOpenConversation(receipt.conversation_id, receipt);
    } finally {
      activeWriters.delete(writer);
    }
  };

  const label = retry ? '重试创建新对话' : '在新对话中继续';
  const button = createElement('button', {
    type: 'button',
    disabled: !canRun,
    'aria-label': label,
    'aria-busy': busy ? 'true' : 'false',
    onClick: activate
  }, label);
  return createElement('div', {className: 'conversation-fork-action'}, button);
}

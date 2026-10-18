import {createChatCompactionRuntime} from '../session-adapter/chat-compaction-runtime.js';
export const name='jot-chat-maintenance-runtime';
export function apply(ctx){ctx.provide('jotChatCompactionRuntime',createChatCompactionRuntime());}

import { dirname, join } from 'node:path';
import { workbenchExecutionConfiguration } from './workbench/model-budget-policy.ts';
import {gitConfiguration} from './git/config.ts';
import {channelAttachmentIntakeConfiguration} from './channels/attachment-config-v2.ts';
import {slackWebhookConfiguration} from './channels/provider-config.ts';
import {smsWebhookConfiguration} from './channels/provider-config.ts';
import type {ChatWebNetworkOptions} from './conversations/chat-web-effects.ts';
function required(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`config_${name.toLowerCase()}_required`);
  return value;
}

export function chatWebNetworkConfiguration(env:NodeJS.ProcessEnv):ChatWebNetworkOptions{
  const allowedOrigins=new Set<string>();
  for(const entry of String(env.JOT_WEB_ORIGINS??'').split(',').map(value=>value.trim()).filter(Boolean)){
    let url:URL;try{url=new URL(entry);}catch{throw new Error('config_jot_web_origins_invalid');}
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('config_jot_web_origins_invalid');
    allowedOrigins.add(url.origin);
  }
  return{allowedOrigins:[...allowedOrigins]};
}

export function loadBffConfig() {
  const requestedIngressMode = process.env.GENERAL_AGENT_INGRESS_MODE?.trim() || 'standalone-local';
  if (requestedIngressMode !== 'standalone-local' && requestedIngressMode !== 'public-api') throw new Error('config_ingress_mode_invalid');
  // No real verified-principal resolver is wired into the production composition yet.
  if (requestedIngressMode === 'public-api') throw new Error('config_public_api_identity_required');
  const ingressMode = 'standalone-local' as const;
  const csrfToken = required('GENERAL_AGENT_CSRF_TOKEN');
  if (csrfToken.length < 16) throw new Error('config_csrf_token_too_short');
  const allowedOrigins = required('GENERAL_AGENT_ALLOWED_ORIGINS').split(',').map(item => item.trim()).filter(Boolean);
  const databasePath = process.env.GENERAL_AGENT_DB?.trim() || '/var/lib/jot/jot.db';
  const slackWebhook = slackWebhookConfiguration(process.env);
  const smsWebhook=smsWebhookConfiguration(process.env);
  const host = process.env.GENERAL_AGENT_HOST?.trim() || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase())) throw new Error('config_public_api_identity_required');
  return {
    ingressMode,
    host,
    port: Number(process.env.GENERAL_AGENT_PORT || 18831),
    databasePath,
    uploadRoot: process.env.GENERAL_AGENT_FILE_ROOT?.trim()
      || process.env.GENERAL_AGENT_UPLOAD_ROOT?.trim()
      || '/var/lib/jot/jot-files',
    workspaces: required('GENERAL_AGENT_WORKSPACES').split(',').map(item => item.trim()).filter(Boolean),
    csrfToken,
    allowedOrigins,
    chatWebNetwork:chatWebNetworkConfiguration(process.env),
    internalChannelToken: required('GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN'),
    ...channelAttachmentIntakeConfiguration(process.env),
    ...(slackWebhook ? { slackWebhook } : {}),
    ...(smsWebhook?{smsWebhook}:{}),
    templateRoot: process.env.GENERAL_AGENT_TEMPLATE_ROOT?.trim()
      || '/opt/jot/general-agent-web/current/file-engine/templates',
    voiceEnabled: process.env.GENERAL_AGENT_VOICE_ENABLED === 'true',
    conversationGoalResumeEnabled:process.env.GENERAL_AGENT_CONVERSATION_GOAL_RESUME_ENABLED==='true',
    workbenchRoot: process.env.GENERAL_AGENT_WORKBENCH_ROOT?.trim() || join(dirname(databasePath), 'jot-workspaces'),
    ...(process.env.GENERAL_AGENT_NATIVE_WORK_ROOT!==undefined?{nativeWorkRoot:process.env.GENERAL_AGENT_NATIVE_WORK_ROOT.trim()}:{}),
    ...workbenchExecutionConfiguration(process.env),
    ...gitConfiguration(process.env),
    voiceAdapterUrl: process.env.GENERAL_AGENT_VOICE_ADAPTER_URL?.trim() || 'http://127.0.0.1:18841',
    voiceAdapterTokenFile: process.env.GENERAL_AGENT_VOICE_ADAPTER_TOKEN_FILE?.trim() || '',
  };
}

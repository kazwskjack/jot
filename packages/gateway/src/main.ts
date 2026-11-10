import {mattermostOwnerBindingConfiguration} from './channels/mattermost-owner-proof.ts';
import { buildServer } from './server.ts';
import { loadBffConfig } from './config.ts';
import { readFileSync } from 'node:fs';
import { VoiceAdapterClient } from './voice/adapter-client.ts';
import {createEmailProvider} from './channels/email-provider.ts';
import {emailConfiguration} from './channels/provider-config.ts';
import {loadWebPushVapidConfiguration} from './channels/web-push-provider.ts';
import {loadReplyJudgeClient} from './persistent-tasks/reply-judge-client.ts';
import {loadMemoryReasoningClient} from './workbench/memory-reasoning-client.ts';
import {SessionControllerClient} from './harness/session-controller-client.ts';
import {SkillCatalogAdapterClient} from './skills/catalog-adapter.ts';
import {loadNativeGitClient} from './git/native-transport-client.ts';
import {artifactArchiveExecutorFromEnvironment} from './artifacts/archive-executor.ts';

const config = loadBffConfig();
const artifactArchiveExecutor=artifactArchiveExecutorFromEnvironment(process.env,config.databasePath,config.uploadRoot);
const nativeGitClient=await loadNativeGitClient(process.env);
const sessionAdapterTokenFile=process.env.GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE?.trim();
const conversationGoalClient=sessionAdapterTokenFile?new SessionControllerClient(
  process.env.GENERAL_AGENT_SESSION_ADAPTER_URL?.trim()||'http://127.0.0.1:18841',readFileSync(sessionAdapterTokenFile,'utf8').trim()):undefined;
const skillCatalogClient=sessionAdapterTokenFile?new SkillCatalogAdapterClient(
  process.env.GENERAL_AGENT_SESSION_ADAPTER_URL?.trim()||'http://127.0.0.1:18841',readFileSync(sessionAdapterTokenFile,'utf8').trim()):undefined;
const pluginProfileFlag=process.env.GENERAL_AGENT_PLUGIN_PROFILE_ENABLED;
if(pluginProfileFlag!==undefined&&!['true','false'].includes(pluginProfileFlag))throw Error('config_plugin_profile_enabled_invalid');
if(pluginProfileFlag==='true'&&!conversationGoalClient)throw Error('config_plugin_profile_adapter_required');
const hostSettingsFlag=process.env.GENERAL_AGENT_HOST_SETTINGS_ENABLED;
const hostSettingsWriteFlag=process.env.GENERAL_AGENT_HOST_SETTINGS_WRITE_ENABLED;
if([hostSettingsFlag,hostSettingsWriteFlag].some(value=>value!==undefined&&value!=='true'&&value!=='false'))throw Error('config_host_settings_enabled_invalid');
const hostSettingsEnabled=hostSettingsFlag==='true',hostSettingsWriteEnabled=hostSettingsWriteFlag==='true';
const hostSettingsNamespaces=(process.env.GENERAL_AGENT_HOST_SETTINGS_NAMESPACES??'').split(',').map(value=>value.trim()).filter(Boolean);
const hostSettingsWriteNamespace=process.env.GENERAL_AGENT_HOST_SETTINGS_WRITE_NAMESPACE?.trim()||'';
if(hostSettingsEnabled&&(!conversationGoalClient||hostSettingsNamespaces.length===0||hostSettingsNamespaces.length>64
 ||new Set(hostSettingsNamespaces).size!==hostSettingsNamespaces.length
 ||hostSettingsNamespaces.some(value=>!/^[a-z][a-z0-9._-]{0,127}$/.test(value)||value==='jot-host-policy')))throw Error('config_host_settings_adapter_required');
if(hostSettingsWriteEnabled&&(!hostSettingsEnabled||hostSettingsWriteNamespace!=='jot-session-adapter'||!hostSettingsNamespaces.includes(hostSettingsWriteNamespace)))throw Error('config_host_settings_write_namespace_invalid');
const hostAdmin=hostSettingsEnabled?{enabled:true,namespaces:hostSettingsNamespaces,client:conversationGoalClient!,
 ...(hostSettingsWriteEnabled?{writeEnabled:true,writeNamespace:hostSettingsWriteNamespace}:{})}:undefined;
let voiceAdapter: VoiceAdapterClient | undefined;
if (config.voiceEnabled) {
  if (!config.voiceAdapterTokenFile) throw new Error('config_general_agent_voice_adapter_token_file_required');
  voiceAdapter = new VoiceAdapterClient(config.voiceAdapterUrl,
    readFileSync(config.voiceAdapterTokenFile, 'utf8').trim());
}
const emailProvider=process.env.GENERAL_AGENT_EMAIL_BINDINGS_ENABLED==='true'?await createEmailProvider(emailConfiguration(process.env)):undefined;
const webPushVapid=loadWebPushVapidConfiguration(process.env);
const replyJudge=loadReplyJudgeClient(process.env,config.modelBudgetPolicy?.routes??[]);
const memoryReasoningClient=loadMemoryReasoningClient(process.env,config.modelBudgetPolicy?.routes??[]);
const service = await buildServer({ ...config,...(artifactArchiveExecutor?{artifactArchiveExecutor}:{}),...(pluginProfileFlag==='true'?{pluginProfileClient:conversationGoalClient!}:{}),...(hostAdmin?{hostAdmin}:{}),...mattermostOwnerBindingConfiguration(process.env),...(nativeGitClient?{nativeGitClient}:{}),chatModeEnabled:process.env.GENERAL_AGENT_CHAT_ENABLED==='true',ordinarySteeringEnabled:process.env.GENERAL_AGENT_ORDINARY_STEERING_ENABLED==='true',ordinaryAttachmentSteeringEnabled:process.env.GENERAL_AGENT_ORDINARY_STEERING_ATTACHMENTS_ENABLED==='true',ordinaryInputRecoveryEnabled:process.env.GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED==='true',matrixOwnerBindingEnabled:Boolean(process.env.GENERAL_AGENT_MATRIX_BASE_URL?.trim()&&process.env.GENERAL_AGENT_MATRIX_ACCESS_TOKEN?.trim()),workAgentPreset:process.env.GENERAL_AGENT_DSH_AGENT_PRESET?.trim()||'jot-general', ...(conversationGoalClient?{conversationGoalClient,terminalInventoryClient:conversationGoalClient,terminalControlClient:conversationGoalClient,terminalStreamClient:conversationGoalClient,nativeMemberClient:conversationGoalClient,taskmasterInstallationClient:conversationGoalClient,conversationForkSourceClient:conversationGoalClient,modelCatalogClient:conversationGoalClient,conversationModeClient:conversationGoalClient,ordinaryAttachmentSteeringClient:conversationGoalClient}:{}),...(skillCatalogClient?{skillCatalogClient}:{}),...(voiceAdapter ? { voiceAdapter } : {}),...(emailProvider?{emailBindingSend:emailProvider.send.bind(emailProvider)}:{}),...(webPushVapid?{webPushVapid:{publicKey:webPushVapid.publicKey,generation:webPushVapid.generation}}:{}),...(replyJudge?{replyJudge}:{}),...(memoryReasoningClient?{memoryReasoningClient}:{}) });
await service.app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => {
  await service.app.close();
  service.db.close();
  process.exit(0);
});

import { buildServer } from './server.ts';
import { loadBffConfig } from './config.ts';
import { readFileSync } from 'node:fs';
import { VoiceAdapterClient } from './voice/adapter-client.ts';
import {createEmailProvider} from './channels/email-provider.ts';
import {emailConfiguration} from './channels/provider-config.ts';
import {loadReplyJudgeClient} from './persistent-tasks/reply-judge-client.ts';
import {SessionControllerClient} from './harness/session-controller-client.ts';

const config = loadBffConfig();
const sessionAdapterTokenFile=process.env.GENERAL_AGENT_SESSION_ADAPTER_TOKEN_FILE?.trim();
const conversationGoalClient=sessionAdapterTokenFile?new SessionControllerClient(
  process.env.GENERAL_AGENT_SESSION_ADAPTER_URL?.trim()||'http://127.0.0.1:18841',readFileSync(sessionAdapterTokenFile,'utf8').trim()):undefined;
let voiceAdapter: VoiceAdapterClient | undefined;
if (config.voiceEnabled) {
  if (!config.voiceAdapterTokenFile) throw new Error('config_general_agent_voice_adapter_token_file_required');
  voiceAdapter = new VoiceAdapterClient(config.voiceAdapterUrl,
    readFileSync(config.voiceAdapterTokenFile, 'utf8').trim());
}
const emailProvider=process.env.GENERAL_AGENT_EMAIL_BINDINGS_ENABLED==='true'?await createEmailProvider(emailConfiguration(process.env)):undefined;
const replyJudge=loadReplyJudgeClient(process.env,config.modelBudgetPolicy?.routes??[]);
const service = await buildServer({ ...config,chatModeEnabled:process.env.GENERAL_AGENT_CHAT_ENABLED==='true',workAgentPreset:process.env.GENERAL_AGENT_DSH_AGENT_PRESET?.trim()||'jot-general', ...(conversationGoalClient?{conversationGoalClient,modelCatalogClient:conversationGoalClient,conversationModeClient:conversationGoalClient}:{}),...(voiceAdapter ? { voiceAdapter } : {}),...(emailProvider?{emailBindingSend:emailProvider.send.bind(emailProvider)}:{}),...(replyJudge?{replyJudge}:{}) });
await service.app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => {
  await service.app.close();
  service.db.close();
  process.exit(0);
});

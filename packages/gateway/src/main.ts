import { buildServer } from './server.ts';
import { loadBffConfig } from './config.ts';
import { readFileSync } from 'node:fs';
import { VoiceAdapterClient } from './voice/adapter-client.ts';

const config = loadBffConfig();
let voiceAdapter: VoiceAdapterClient | undefined;
if (config.voiceEnabled) {
  if (!config.voiceAdapterTokenFile) throw new Error('config_general_agent_voice_adapter_token_file_required');
  voiceAdapter = new VoiceAdapterClient(config.voiceAdapterUrl,
    readFileSync(config.voiceAdapterTokenFile, 'utf8').trim());
}
const service = await buildServer({ ...config, ...(voiceAdapter ? { voiceAdapter } : {}) });
await service.app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => {
  await service.app.close();
  service.db.close();
  process.exit(0);
});

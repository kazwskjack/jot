function required(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`config_${name.toLowerCase()}_required`);
  return value;
}

export function loadBffConfig() {
  const csrfToken = required('GENERAL_AGENT_CSRF_TOKEN');
  if (csrfToken.length < 16) throw new Error('config_csrf_token_too_short');
  const allowedOrigins = required('GENERAL_AGENT_ALLOWED_ORIGINS').split(',').map(item => item.trim()).filter(Boolean);
  return {
    host: process.env.GENERAL_AGENT_HOST?.trim() || '127.0.0.1',
    port: Number(process.env.GENERAL_AGENT_PORT || 18831),
    databasePath: process.env.GENERAL_AGENT_DB?.trim() || '/var/lib/jot/jot.db',
    uploadRoot: process.env.GENERAL_AGENT_FILE_ROOT?.trim()
      || process.env.GENERAL_AGENT_UPLOAD_ROOT?.trim()
      || '/var/lib/jot/jot-files',
    workspaces: required('GENERAL_AGENT_WORKSPACES').split(',').map(item => item.trim()).filter(Boolean),
    csrfToken,
    allowedOrigins,
    internalChannelToken: required('GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN'),
    templateRoot: process.env.GENERAL_AGENT_TEMPLATE_ROOT?.trim()
      || '/opt/jot/general-agent-web/current/file-engine/templates',
    voiceEnabled: process.env.GENERAL_AGENT_VOICE_ENABLED === 'true',
    voiceAdapterUrl: process.env.GENERAL_AGENT_VOICE_ADAPTER_URL?.trim() || 'http://127.0.0.1:18841',
    voiceAdapterTokenFile: process.env.GENERAL_AGENT_VOICE_ADAPTER_TOKEN_FILE?.trim() || '',
  };
}

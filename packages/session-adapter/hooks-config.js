// Adapted from PilotDeck revision 783499ffdb2d501bf590b2e035acd027a882df10.
// See runtime-patches/PILOTDECK-AGPL-3.0.txt for the upstream GNU AGPL v3 license.
export const HOOK_EVENTS = Object.freeze([
  'PreToolUse','PostToolUse','PostToolUseFailure','Notification','UserPromptSubmit','PreModelRequest',
  'SessionStart','SessionEnd','Stop','StopFailure','SubagentStart','SubagentStop','PreCompact','PostCompact',
  'PermissionRequest','PermissionDenied','Setup','ConfigChange','InstructionsLoaded','CwdChanged',
  'FileChanged','WorktreeCreate','WorktreeRemove','Elicitation','ElicitationResult',
]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value : undefined;
const boolean = value => typeof value === 'boolean' ? value : undefined;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Persistent declarations describe Hooks. Runtime authorization is supplied separately. */
export function parseHooksConfig(raw) {
  const settings = {}, diagnostics = [];
  if (raw === undefined || raw === null) return {settings,diagnostics};
  if (!record(raw)) return {settings,diagnostics:['Hooks config must be an object.']};
  let encoded;
  try {encoded = JSON.stringify(raw);} catch {return {settings,diagnostics:['Hooks config must contain JSON data.']};}
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) return {settings,diagnostics:['Hooks config exceeds the Host limit.']};
  for (const [eventName, rawMatchers] of Object.entries(raw)) {
    if (!HOOK_EVENTS.includes(eventName)) {
      diagnostics.push(`Unsupported hook event ${eventName}.`); continue;
    }
    if (!Array.isArray(rawMatchers)) {
      diagnostics.push(`Hook event ${eventName} must contain an array of matchers.`); continue;
    }
    const matchers = [];
    for (const rawMatcher of rawMatchers) {
      if (!record(rawMatcher) || !Array.isArray(rawMatcher.hooks)) {
        diagnostics.push(`Hook matcher for ${eventName} must contain hooks array.`); continue;
      }
      const hooks = [];
      for (const rawHook of rawMatcher.hooks) {
        const hook = parseCommand(eventName, rawHook, diagnostics);
        if (hook) hooks.push(hook);
      }
      matchers.push({matcher:string(rawMatcher.matcher),pluginName:string(rawMatcher.pluginName),
        pluginId:string(rawMatcher.pluginId),pluginRoot:string(rawMatcher.pluginRoot),hooks});
    }
    if (matchers.length) settings[eventName] = matchers;
  }
  return {settings,diagnostics};
}

function parseCommand(eventName, raw, diagnostics) {
  if (!record(raw) || typeof raw.type !== 'string') {
    diagnostics.push(`Hook for ${eventName} must contain a type.`); return;
  }
  const common = {if:string(raw.if),statusMessage:string(raw.statusMessage),once:boolean(raw.once),timeout:number(raw.timeout)};
  switch (raw.type) {
    case 'command':
      if (typeof raw.command !== 'string') {
        diagnostics.push(`Command hook for ${eventName} must contain command.`); return;
      }
      return {type:'command',command:raw.command,shell:['powershell','bash'].includes(raw.shell)?raw.shell:undefined,
        async:boolean(raw.async),asyncRewake:boolean(raw.asyncRewake),...common};
    case 'prompt':
    case 'agent':
      if (typeof raw.prompt !== 'string') {
        diagnostics.push(`Prompt hook for ${eventName} must contain prompt.`); return;
      }
      return {type:raw.type,prompt:raw.prompt,model:string(raw.model),...common};
    case 'http':
      if (typeof raw.url !== 'string') {
        diagnostics.push(`HTTP hook for ${eventName} must contain url.`); return;
      }
      return {type:'http',url:raw.url,
        headers:record(raw.headers)?Object.fromEntries(Object.entries(raw.headers).filter(([,value])=>typeof value==='string')):undefined,
        allowedEnvVars:Array.isArray(raw.allowedEnvVars)?raw.allowedEnvVars.filter(value=>typeof value==='string'):undefined,
        ...common};
    case 'callback':
      diagnostics.push(`Callback hook for ${eventName} is runtime-only and cannot be loaded from persistent config.`); return;
    default:
      diagnostics.push(`Unsupported hook type ${raw.type} for ${eventName}.`);
  }
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createHooksConfiguration(raw) {
  const parsed = parseHooksConfig(raw);
  if (parsed.diagnostics.length) throw new Error('jot_hooks_configuration_invalid');
  return freeze({protocol:1,supported_events:HOOK_EVENTS,configured_events:Object.keys(parsed.settings),
    settings:parsed.settings,execution_authorized:false});
}

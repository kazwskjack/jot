const SERVER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const SECRET_REF = /^secret:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,253}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const UNSAFE_VALUE = /(?:bearer\s+\S+|(?:token|secret|password|api[_-]?key)=\S+)/i;

function record(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw new Error('MCP 输入格式无效');
}

function refs(value, keyPattern) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) throw new Error('秘密引用必须是 JSON 对象');
  for (const [key, ref] of Object.entries(value)) {
    if (!keyPattern.test(key) || typeof ref !== 'string' || !SECRET_REF.test(ref)) throw new Error('只接受 secret:// 秘密引用，不接受秘密值');
  }
  return value;
}

function parseJson(text, fallback, label) {
  if (!text.trim()) return fallback;
  try { return JSON.parse(text); } catch { throw new Error(`${label}不是有效 JSON`); }
}

function safeHttpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('HTTP 服务地址无效'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(key => /(?:token|secret|password|api[_-]?key)/i.test(key))) {
    throw new Error('服务地址必须使用安全 URL，秘密需填写为引用');
  }
}

export function buildMcpConfig(draft) {
  if (!draft || typeof draft !== 'object' || !SERVER_NAME.test(draft.server_name ?? '')) throw new Error('服务名称格式无效');
  if (draft.transport === 'stdio') {
    const args = parseJson(draft.args_json ?? '', [], '启动参数');
    const envRefs = parseJson(draft.env_refs_json ?? '', {}, '环境秘密引用');
    if (typeof draft.command !== 'string' || !draft.command.trim() || draft.command.length > 1024) throw new Error('启动命令无效');
    if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4096)) throw new Error('启动参数必须是字符串数组');
    if (UNSAFE_VALUE.test(draft.command) || args.some(arg => UNSAFE_VALUE.test(arg)) || (draft.cwd?.trim() && UNSAFE_VALUE.test(draft.cwd))) throw new Error('启动配置包含疑似秘密值，请改用 secret:// 引用');
    refs(envRefs, ENV_NAME);
    const config = { server_name: draft.server_name, transport: 'stdio', command: draft.command };
    if (args.length) config.args = args;
    if (draft.cwd?.trim()) {
      if (draft.cwd.length > 2048) throw new Error('工作目录过长');
      config.cwd = draft.cwd;
    }
    if (Object.keys(envRefs).length) config.env_refs = envRefs;
    return config;
  }
  if (draft.transport === 'streamable-http') {
    const headerRefs = parseJson(draft.header_refs_json ?? '', {}, 'HTTP 秘密引用');
    refs(headerRefs, HEADER_NAME);
    if (typeof draft.url !== 'string' || !draft.url.trim() || draft.url.length > 2048) throw new Error('HTTP 服务地址无效');
    safeHttpUrl(draft.url);
    const config = { server_name: draft.server_name, transport: 'streamable-http', url: draft.url };
    if (Object.keys(headerRefs).length) config.header_refs = headerRefs;
    return config;
  }
  throw new Error('请选择支持的 MCP 传输方式');
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !SERVER_NAME.test(config.server_name ?? '')) throw new Error('MCP 命令配置无效');
  if (config.transport === 'stdio') {
    record(config, ['server_name', 'transport', 'command', 'args', 'cwd', 'env_refs'], ['server_name', 'transport', 'command']);
    if (typeof config.command !== 'string' || !config.command.trim() || config.command.length > 1024) throw new Error('MCP 命令配置无效');
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.length > 64 || config.args.some(arg => typeof arg !== 'string' || arg.length > 4096))) throw new Error('MCP 命令参数无效');
    if (config.cwd !== undefined && (typeof config.cwd !== 'string' || config.cwd.length > 2048)) throw new Error('MCP 工作目录无效');
    if (UNSAFE_VALUE.test(config.command) || (config.args ?? []).some(arg => UNSAFE_VALUE.test(arg)) || (config.cwd && UNSAFE_VALUE.test(config.cwd))) throw new Error('MCP 配置包含疑似秘密值');
    if (config.env_refs !== undefined) refs(config.env_refs, ENV_NAME);
    return;
  }
  if (config.transport === 'streamable-http') {
    record(config, ['server_name', 'transport', 'url', 'header_refs'], ['server_name', 'transport', 'url']);
    if (typeof config.url !== 'string' || !config.url.trim() || config.url.length > 2048) throw new Error('MCP 地址无效');
    safeHttpUrl(config.url);
    if (config.header_refs !== undefined) refs(config.header_refs, HEADER_NAME);
    return;
  }
  throw new Error('MCP 传输方式无效');
}

function validateCommand(value, agentId) {
  record(value, ['path', 'method', 'body', 'key'], ['path', 'method', 'body', 'key']);
  if (typeof value.key !== 'string' || !/^[\x21-\x7E]{8,128}$/.test(value.key)) throw new Error('MCP 幂等回执无效');
  const base = `/agents/${encodeURIComponent(agentId)}/mcp/connections`;
  if (value.path === base && value.method === 'POST') {
    validateConfig(value.body);
    return;
  }
  const match = typeof value.path === 'string' && value.path.startsWith(base + '/')
    && value.path.slice(base.length + 1).match(/^([^/]+)(?:\/(config|enabled|tools|reload))?$/);
  if (!match) throw new Error('MCP 命令路径无效');
  let connectionId;try{connectionId=decodeURIComponent(match[1]);}catch{throw Error('MCP 命令路径无效');}
  if(!ID.test(connectionId)||(match[1]!==connectionId&&match[1]!==encodeURIComponent(connectionId)))throw Error('MCP 命令路径无效');
  const suffix = match[2] ?? '';
  const body = value.body;
  if (['config', 'enabled', 'tools', 'reload', ''].includes(suffix) && !Number.isSafeInteger(body?.expected_version) && suffix !== '') throw new Error('MCP 连接版本无效');
  if (suffix === 'config' && value.method === 'PATCH') {
    record(body, ['expected_version', 'config'], ['expected_version', 'config']);
    validateConfig(body.config);
  } else if (suffix === 'enabled' && value.method === 'PATCH') {
    record(body, ['expected_version', 'enabled'], ['expected_version', 'enabled']);
    if (typeof body.enabled !== 'boolean') throw new Error('MCP 启用状态无效');
  } else if (suffix === 'tools' && value.method === 'PUT') {
    record(body, ['expected_version', 'tool_ids'], ['expected_version', 'tool_ids']);
    if (!Array.isArray(body.tool_ids) || body.tool_ids.length > 100 || body.tool_ids.some(id => typeof id !== 'string' || !/^mcp_[a-f0-9]{32}$/.test(id))) throw new Error('MCP 工具授权无效');
  } else if (suffix === 'reload' && value.method === 'POST') {
    record(body, ['expected_version'], ['expected_version']);
  } else if (suffix === '' && value.method === 'DELETE') {
    record(body, ['expected_version'], ['expected_version']);
  } else throw new Error('MCP 命令类型无效');
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) throw new Error('MCP 连接版本无效');
}

// Stores only a single already-reviewed mutation, isolated by the BFF's owner
// scope and agent. This browser cache is not a server admission/operation log.
// It accepts only MCP configuration routes, never SDK package installation.
export class McpCommandStore {
  constructor(storage, scope, agentId, capabilityEpoch) {
    if (!/^[a-f0-9]{64}$/.test(scope) || !ID.test(agentId)) throw new Error('MCP 用户范围不可用');
    if (!Number.isSafeInteger(capabilityEpoch) || capabilityEpoch < 0) throw new Error('MCP_CAPABILITY_EPOCH_UNAVAILABLE');
    this.storage = storage;
    this.agentId = agentId;
    this.capabilityEpoch = capabilityEpoch;
    this.key = `jot-mcp-command/v1/${scope}/${encodeURIComponent(agentId)}`;
  }
  read() {
    const text = this.storage.getItem(this.key);
    if (!text) return null;
    if (text.length > 80000) throw new Error('MCP 命令回执过大');
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('MCP 命令回执格式无效'); }
    record(data, ['version', 'command', 'capability_epoch'], ['version', 'command']);
    if (![1, 2].includes(data.version)) throw new Error('MCP 命令回执版本无效');
    if (data.command !== null) validateCommand(data.command, this.agentId);
    if (data.version === 1 && data.command !== null) throw new Error('MCP_RECEIPT_EPOCH_UNKNOWN');
    if (data.version === 2 && (!Number.isSafeInteger(data.capability_epoch) || data.capability_epoch < 0)) throw new Error('MCP 命令回执代次无效');
    if (data.command !== null && data.capability_epoch !== this.capabilityEpoch) throw new Error('MCP_RECEIPT_EPOCH_CHANGED');
    return data;
  }
  /** @param {{path:string,method:string,body:unknown,key:string}|null} command
   * @param {{key:string}} [expected] */
  saveCommand(command, expected) {
    if (command === null) { this.complete(expected); return; }
    validateCommand(command, this.agentId);
    const current=this.read()?.command;
    if(current&&JSON.stringify(current)!==JSON.stringify(command))throw Error('MCP_COMMAND_PENDING');
    const text = JSON.stringify({ version: 2, capability_epoch: this.capabilityEpoch, command });
    if (text.length > 80000) throw new Error('MCP 命令回执过大');
    this.storage.setItem(this.key, text);
    if(this.storage.getItem(this.key)!==text)throw Error('MCP_COMMAND_STORAGE_UNAVAILABLE');
  }
  /** @param {{key:string}} [expected] */
  complete(expected) {
    const current=this.read()?.command;
    if(!current||expected&&current.key!==expected.key)return;
    this.storage.removeItem(this.key);
    if(this.storage.getItem(this.key)!==null)throw Error('MCP_COMMAND_STORAGE_UNAVAILABLE');
  }
}

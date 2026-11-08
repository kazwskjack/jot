const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TOOL_ID = /^mcp_[a-f0-9]{32}$/;
const WIRE_NAME = /^jot_mcp_[a-z0-9_]{1,50}$/;
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const UNSAFE_VALUE = /(?:bearer\s+\S+|(?:token|secret|password|api[_-]?key)=\S+)/i;
const INPUT_SCHEMA_KEYS = new Set(['additionalProperties', 'allOf', 'anyOf', 'const', 'default', 'deprecated', 'description',
  'enum', 'examples', 'exclusiveMaximum', 'exclusiveMinimum', 'items', 'maximum', 'maxItems', 'maxLength', 'maxProperties',
  'minimum', 'minItems', 'minLength', 'minProperties', 'not', 'oneOf', 'properties', 'readOnly', 'required', 'title', 'type',
  'uniqueItems', 'writeOnly', '$comment']);
const INPUT_SCHEMA_ANNOTATION_KEYS = new Set(['default', 'deprecated', 'description', 'examples', 'readOnly', 'title', 'writeOnly', '$comment']);
const MAX_MCP_INPUT_BYTES = 65_536;
const mcpExecutionInputs = new WeakMap();

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyJsonValue(value, errorCode, state = {seen: new Set(), nodes: 0}, depth = 0) {
  const fail = () => { throw new Error(errorCode); };
  if (++state.nodes > 8192 || depth > 32) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fail();
  if (!value || typeof value !== 'object' || state.seen.has(value)) fail();
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 4096) fail();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        const index = typeof key === 'string' ? Number(key) : NaN;
        const descriptor = descriptors[key];
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key
          || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      }
      const output = new Array(value.length);
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        output[index] = copyJsonValue(descriptor.value, errorCode, state, depth + 1);
      }
      return output;
    }
    if (!isPlainRecord(value) || Reflect.ownKeys(value).length > 1024) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      Object.defineProperty(output, key, { value: copyJsonValue(descriptor.value, errorCode, state, depth + 1),
        enumerable: true, writable: true, configurable: true });
    }
    return output;
  } catch {
    fail();
  } finally {
    state.seen.delete(value);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function validateInputSchema(schema, depth = 0, budget = {nodes: 0}) {
  const fail = () => { throw new Error('mcp_context_invalid'); };
  if (++budget.nodes > 2048 || depth > 32) fail();
  if (typeof schema === 'boolean') return;
  if (!isPlainRecord(schema) || Object.keys(schema).length > 64) fail();
  for (const key of Object.keys(schema)) if (!INPUT_SCHEMA_KEYS.has(key)) fail();
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.length > 7 || new Set(types).size !== types.length
      || types.some(type => !['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'].includes(type))) fail();
  }
  if (schema.properties !== undefined) {
    if (!isPlainRecord(schema.properties) || Object.keys(schema.properties).length > 128) fail();
    for (const child of Object.values(schema.properties)) validateInputSchema(child, depth + 1, budget);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 128
    || schema.required.some(key => typeof key !== 'string' || !key || key.length > 128)
    || new Set(schema.required).size !== schema.required.length)) fail();
  if (schema.additionalProperties !== undefined) {
    if (typeof schema.additionalProperties === 'boolean') {}
    else validateInputSchema(schema.additionalProperties, depth + 1, budget);
  }
  if (schema.items !== undefined) validateInputSchema(schema.items, depth + 1, budget);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key]) || schema[key].length < 1 || schema[key].length > 32) fail();
    for (const child of schema[key]) validateInputSchema(child, depth + 1, budget);
  }
  if (schema.not !== undefined) validateInputSchema(schema.not, depth + 1, budget);
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) fail();
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
    if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0 || schema[key] > 65_536)) fail();
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') fail();
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 256)) fail();
  for (const key of INPUT_SCHEMA_ANNOTATION_KEYS) {
    if (schema[key] !== undefined && (key === 'description' || key === 'title' || key === '$comment')
      && (typeof schema[key] !== 'string' || schema[key].length > 2048)) fail();
    if (schema[key] !== undefined && key === 'deprecated' && typeof schema[key] !== 'boolean') fail();
    if (schema[key] !== undefined && ['readOnly', 'writeOnly'].includes(key) && typeof schema[key] !== 'boolean') fail();
  }
}

function matchesInputSchema(value, schema, depth = 0) {
  if (depth > 32) return false;
  if (schema === true) return true;
  if (schema === false) return false;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matchesType = type => type === 'null' ? value === null
      : type === 'array' ? Array.isArray(value)
        : type === 'object' ? isPlainRecord(value)
          : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
            : type === 'number' ? typeof value === 'number'
              : typeof value === type;
    if (!types.some(matchesType)) return false;
  }
  if (Object.hasOwn(schema, 'const') && canonicalJson(value) !== canonicalJson(schema.const)) return false;
  if (schema.enum && !schema.enum.some(candidate => canonicalJson(value) === canonicalJson(candidate))) return false;
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum
      || schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum
      || schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value.map(canonicalJson)).size !== value.length) return false;
    if (schema.items !== undefined && value.some(item => !matchesInputSchema(item, schema.items, depth + 1))) return false;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties || schema.maxProperties !== undefined && keys.length > schema.maxProperties) return false;
    if (schema.required && schema.required.some(key => !Object.hasOwn(value, key))) return false;
    const properties = schema.properties ?? Object.create(null);
    for (const key of keys) {
      if (Object.hasOwn(properties, key)) {
        if (!matchesInputSchema(value[key], properties[key], depth + 1)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties && !matchesInputSchema(value[key], schema.additionalProperties, depth + 1)) return false;
    }
  }
  if (schema.allOf && !schema.allOf.every(child => matchesInputSchema(value, child, depth + 1))) return false;
  if (schema.anyOf && !schema.anyOf.some(child => matchesInputSchema(value, child, depth + 1))) return false;
  if (schema.oneOf && schema.oneOf.filter(child => matchesInputSchema(value, child, depth + 1)).length !== 1) return false;
  if (schema.not && matchesInputSchema(value, schema.not, depth + 1)) return false;
  return true;
}

/** Compile the explicitly supported, bounded JSON Schema subset used at dispatch time. */
export function compileMcpToolInputValidator(schema) {
  const normalized = copyJsonValue(schema, 'mcp_context_invalid');
  if (!isPlainRecord(normalized) || normalized.type !== 'object') throw new Error('mcp_context_invalid');
  validateInputSchema(normalized);
  return value => {
    const input = copyJsonValue(value, 'mcp_input_invalid');
    if (!isPlainRecord(input) || Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_MCP_INPUT_BYTES
      || !matchesInputSchema(input, normalized)) throw new Error('mcp_input_invalid');
    return input;
  };
}

function validSecretReference(value, ownerId) {
  if (typeof value !== 'string' || !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,253}$/.test(value)) return false;
  if (ownerId === undefined) return true;
  const prefix = 'secret://' + ownerId + '/';
  return value.startsWith(prefix) && value.length > prefix.length;
}

function validConfig(connection, ownerId) {
  const config = connection.config;
  if (config.server_name !== connection.server_name || config.transport !== connection.transport) return false;
  if (connection.transport === 'stdio') {
    if (!own(config, ['server_name', 'transport', 'command', 'args', 'cwd', 'env_refs'])
      || typeof config.command !== 'string' || !config.command || config.command.length > 1024 || UNSAFE_VALUE.test(config.command)
      || config.args !== undefined && (!Array.isArray(config.args) || config.args.length > 64
        || config.args.some(value => typeof value !== 'string' || value.length > 4096 || UNSAFE_VALUE.test(value)))
      || config.cwd !== undefined && (typeof config.cwd !== 'string' || !config.cwd || config.cwd.length > 2048 || UNSAFE_VALUE.test(config.cwd))
      || !config.env_refs || typeof config.env_refs !== 'object' || Array.isArray(config.env_refs)) return false;
    return Object.entries(config.env_refs).every(([key, ref]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)
      && validSecretReference(ref, ownerId));
  }
  if (!own(config, ['server_name', 'transport', 'url', 'header_refs']) || typeof config.url !== 'string'
    || !config.header_refs || typeof config.header_refs !== 'object' || Array.isArray(config.header_refs)) return false;
  try {
    const url = new URL(config.url), loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !loopback
      || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /token|secret|password|api[_-]?key/i.test(key))) return false;
  } catch { return false; }
  return Object.entries(config.header_refs).every(([key, ref]) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(key)
    && validSecretReference(ref, ownerId));
}

export function validateMcpConnections(value, ownerId) {
  if (!Array.isArray(value) || value.length > 64
    || ownerId !== undefined && (typeof ownerId !== 'string' || !ID.test(ownerId))) throw new Error('mcp_context_invalid');
  const names = new Set(), bindings = new Map(), inputValidators = new Map();
  const connections = value.map(connection => {
    if (!own(connection, ['connection_id', 'server_name', 'transport', 'version', 'generation', 'config', 'tools'])
      || typeof connection.connection_id !== 'string' || !ID.test(connection.connection_id)
      || typeof connection.server_name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(connection.server_name)
      || !['stdio', 'streamable-http'].includes(connection.transport)
      || !Number.isSafeInteger(connection.version) || connection.version < 1
      || !Number.isSafeInteger(connection.generation) || connection.generation < 1
      || !connection.config || typeof connection.config !== 'object' || Array.isArray(connection.config)
      || !validConfig(connection, ownerId)
      || !Array.isArray(connection.tools) || connection.tools.length > 100) throw new Error('mcp_context_invalid');
    const tools = connection.tools.map(tool => {
      if (!own(tool, ['tool_id', 'public_name', 'raw_name', 'description', 'input_schema', 'approved'])
        || typeof tool.tool_id !== 'string' || !TOOL_ID.test(tool.tool_id)
        || typeof tool.public_name !== 'string' || !WIRE_NAME.test(tool.public_name)
        || typeof tool.raw_name !== 'string' || !tool.raw_name || tool.raw_name.length > 128
        || typeof tool.description !== 'string' || tool.description.length > 2048
        || !tool.input_schema || typeof tool.input_schema !== 'object' || Array.isArray(tool.input_schema)
        || tool.input_schema.type !== 'object' || tool.approved !== true) throw new Error('mcp_context_invalid');
      const inputSchema = copyJsonValue(tool.input_schema, 'mcp_context_invalid');
      const schemaJson = JSON.stringify(inputSchema);
      if (Buffer.byteLength(schemaJson, 'utf8') > 16384) throw new Error('mcp_context_invalid');
      const validateInput = compileMcpToolInputValidator(inputSchema);
      if (names.has(tool.public_name)) throw new Error('mcp_context_invalid');
      names.add(tool.public_name);
      bindings.set(tool.public_name, Object.freeze({ connection_id: connection.connection_id,
        generation: connection.generation, tool_id: tool.tool_id }));
      inputValidators.set(tool.public_name, validateInput);
      return Object.freeze({ ...tool, input_schema: inputSchema });
    });
    return Object.freeze({ ...connection, config: structuredClone(connection.config), tools: Object.freeze(tools) });
  });
  if (names.size > 128) throw new Error('mcp_context_invalid');
  return { connections: Object.freeze(connections), bindings, inputValidators, toolNames: Object.freeze([...names]) };
}

/** Enforce the arguments approved before Gateway prepare at the native SDK dispatch boundary. */
export function assertMcpExecutionInput(exec, args) {
  const expected = exec && typeof exec === 'object' ? mcpExecutionInputs.get(exec) : undefined;
  if (!expected) throw new Error('mcp_input_snapshot_unavailable');
  const current = copyJsonValue(args, 'mcp_input_changed');
  if (canonicalJson(current) !== canonicalJson(expected)) throw new Error('mcp_input_changed');
  return true;
}

/** Attaches only the exact approved tool names published by the Gateway. */
export async function attachMcpRuntime({ provider, agent, connections, signal, ownerId, agentId, assertCurrent }) {
  if (ownerId !== undefined && (typeof ownerId !== 'string' || !ID.test(ownerId))
    || agentId !== undefined && (typeof agentId !== 'string' || !ID.test(agentId))
    || (ownerId === undefined) !== (agentId === undefined)
    || assertCurrent !== undefined && typeof assertCurrent !== 'function') throw new Error('mcp_context_invalid');
  const expected = validateMcpConnections(connections, ownerId);
  const validateInput = (name, args) => {
    const validate = expected.inputValidators.get(name);
    if (!validate) throw new Error('mcp_input_schema_unavailable');
    return validate(args);
  };
  if (!expected.toolNames.length) return { toolNames: [], bindingForName: () => undefined, validateInput, close: async () => {} };
  if (!provider || typeof provider.attach !== 'function') {
    return { toolNames: [], bindingForName: () => undefined, validateInput, close: async () => {}, errorCode: 'mcp_runtime_unavailable' };
  }
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await provider.attach({ agent, connections: expected.connections, signal,
      ...(ownerId === undefined ? {} : {ownerId, agentId}), ...(assertCurrent === undefined ? {} : {assertCurrent}) });
    signal?.throwIfAborted();
    if (!handle || !own(handle, ['tool_names', 'close']) || !Array.isArray(handle.tool_names)
      || typeof handle.close !== 'function' || new Set(handle.tool_names).size !== handle.tool_names.length
      || handle.tool_names.some(name => typeof name !== 'string' || !expected.bindings.has(name))) {
      throw new Error('mcp_runtime_tool_mismatch');
    }
    const names = Object.freeze([...handle.tool_names]);
    return { toolNames: names, bindingForName: name => names.includes(name) ? expected.bindings.get(name) : undefined, validateInput,
      close: async () => { try { await handle.close(); } catch { /* Scope cleanup cannot keep the Session alive. */ } } };
  } catch {
    try { await handle?.close?.(); } catch { /* Partially mounted DSH provider is best-effort disposed. */ }
    signal?.throwIfAborted();
    return { toolNames: [], bindingForName: () => undefined, validateInput, close: async () => {}, errorCode: 'mcp_runtime_unavailable' };
  }
}

function validReceipt(receipt) {
  return !!receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && Object.keys(receipt).every(key => ['kind', 'reference', 'hash'].includes(key))
    && receipt.kind === 'tool_receipt' && typeof receipt.reference === 'string' && ID.test(receipt.reference)
    && typeof receipt.hash === 'string' && /^[a-f0-9]{64}$/.test(receipt.hash);
}

function encodeResult(result, receipt) {
  if (!validReceipt(receipt)) throw new Error('mcp_operation_unknown');
  try { return JSON.stringify({ result, execution_receipt: receipt }); }
  catch { throw new Error('mcp_result_invalid'); }
}

function validPrepareReply(reply) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply) || typeof reply.dispatch !== 'boolean') return false;
  if (reply.dispatch) return reply.state === 'dispatched' && typeof reply.operation_id === 'string' && ID.test(reply.operation_id);
  if (reply.state === 'unknown') return true;
  return reply.state === 'settled' && Object.hasOwn(reply, 'result') && validReceipt(reply.execution_receipt);
}

function knownPrepareDenial(error) {
  return error instanceof Error && ['workbench_run_forbidden', 'WORKBENCH_TOOL_FORBIDDEN'].includes(error.message);
}

/** Wraps a native DSH registered MCP tool with the original Gateway guard and receipt ledger. */
export async function executeMcpTool({ exec, binding, next, request, check, validateInput }) {
  if (!exec || typeof exec !== 'object' || typeof exec.name !== 'string' || typeof exec.callId !== 'string' || !ID.test(exec.callId)
    || !exec.arguments || typeof exec.arguments !== 'object' || Array.isArray(exec.arguments)
    || typeof request !== 'function' || typeof check !== 'function' || typeof next !== 'function'
    || typeof validateInput !== 'function') throw new Error('mcp_call_invalid');
  if (!binding || typeof binding.connection_id !== 'string' || !ID.test(binding.connection_id)
    || !Number.isSafeInteger(binding.generation) || typeof binding.tool_id !== 'string' || !TOOL_ID.test(binding.tool_id)) {
    throw new Error('mcp_call_invalid');
  }
  const originalArguments = validateInput(exec.name, exec.arguments);
  const assertArgumentsUnchanged = () => {
    const latest = validateInput(exec.name, exec.arguments);
    if (canonicalJson(latest) !== canonicalJson(originalArguments)) throw new Error('mcp_input_changed');
  };
  mcpExecutionInputs.set(exec, originalArguments);
  try {
    exec.signal?.throwIfAborted();
    await check(exec.name, exec.signal);
    const preparePayload = { ...binding, call_id: exec.callId, arguments: originalArguments };
    let prepared, recoveredPrepare = false;
    try {
      prepared = await request('prepare', preparePayload, exec.signal);
      if (!validPrepareReply(prepared)) recoveredPrepare = true;
    } catch (error) {
      if (knownPrepareDenial(error)) throw error;
      recoveredPrepare = true;
    }
    if (recoveredPrepare) {
      // A lost or malformed response leaves the durable call outcome uncertain.
      // Re-enter the Gateway journal with the same call id and without the caller's
      // aborted signal. A fresh dispatch grant from this recovery request is never
      // consumed: it is sealed unknown below before the provider can run.
      try { prepared = await request('prepare', preparePayload); }
      catch { throw new Error('mcp_operation_unknown'); }
      if (!validPrepareReply(prepared)) throw new Error('mcp_operation_unknown');
      if (prepared.dispatch) {
        try { await request('settle', { operation_id: prepared.operation_id, state: 'unknown', reason_code: 'mcp_operation_unknown' }); }
        catch { /* The durable dispatched row is recovered as unknown and never replayed. */ }
        throw new Error('mcp_operation_unknown');
      }
    }
    if (!prepared.dispatch) {
      if (prepared.state === 'settled') {
        assertArgumentsUnchanged();
        return encodeResult(prepared.result, prepared.execution_receipt);
      }
      throw new Error('mcp_operation_unknown');
    }
    if (typeof prepared.operation_id !== 'string' || !ID.test(prepared.operation_id)) throw new Error('mcp_operation_unknown');
    try {
    if (prepared.state !== 'dispatched') throw new Error('mcp_operation_unknown');
    exec.signal?.throwIfAborted();
    await check(exec.name, exec.signal);
    exec.signal?.throwIfAborted();
    assertArgumentsUnchanged();
    const result = await next();
    assertArgumentsUnchanged();
    const settled = await request('settle', { operation_id: prepared.operation_id, state: 'settled', result });
    if (settled?.state !== 'settled' || !settled.execution_receipt) throw new Error('mcp_operation_unknown');
    return encodeResult(result, settled.execution_receipt);
  } catch {
    try { await request('settle', { operation_id: prepared.operation_id, state: 'unknown', reason_code: 'mcp_operation_unknown' }); }
    catch { /* A retained dispatched row is recovered as unknown and never replayed. */ }
    throw new Error('mcp_operation_unknown');
    }
  } finally {
    mcpExecutionInputs.delete(exec);
  }
}

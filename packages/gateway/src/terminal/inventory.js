const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys;
const dimension = value => Number.isSafeInteger(value) && value > 0;

/** Public metadata only. Native error diagnostics stay inside the Host. */
export function projectTerminalInventory(sessionId, terminals) {
  if (!Array.isArray(terminals)) throw Error('terminal_inventory_invalid');
  return validateTerminalInventory({
    protocol: 1, session_id: sessionId, execution_authorized: false,
    terminals: terminals.map(info => ({
      id: info?.id, title: info?.title,
      shell: {path: info?.shell?.path, name: info?.shell?.name, args: info?.shell?.args},
      cwd: info?.cwd, cols: info?.cols, rows: info?.rows, state: info?.state, exitCode: info?.exitCode,
    })),
  }, sessionId);
}

export function validateTerminalInventory(value, sessionId) {
  const fail = () => { throw Error('terminal_inventory_invalid'); };
  if (typeof sessionId !== 'string' || !ID.test(sessionId)
      || !exact(value, 'execution_authorized,protocol,session_id,terminals')
      || value.protocol !== 1 || value.session_id !== sessionId || value.execution_authorized !== false
      || !Array.isArray(value.terminals)) return fail();
  const seen = new Set();
  const terminals = value.terminals.map(info => {
    if (!exact(info, 'cols,cwd,exitCode,id,rows,shell,state,title')
        || typeof info.id !== 'string' || !ID.test(info.id) || seen.has(info.id)
        || typeof info.title !== 'string' || !info.title.trim() || info.title.length > 120
        || typeof info.cwd !== 'string' || !info.cwd || info.cwd.includes('\0')
        || !dimension(info.cols) || !dimension(info.rows)
        || !['running', 'exited', 'failed'].includes(info.state)
        || info.exitCode !== null && !Number.isSafeInteger(info.exitCode)
        || !exact(info.shell, 'args,name,path')
        || typeof info.shell.path !== 'string' || !info.shell.path || info.shell.path.includes('\0')
        || typeof info.shell.name !== 'string' || !info.shell.name
        || !Array.isArray(info.shell.args) || info.shell.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) return fail();
    seen.add(info.id);
    return Object.freeze({...info, shell: Object.freeze({...info.shell, args: Object.freeze([...info.shell.args])})});
  });
  return Object.freeze({protocol: 1, session_id: sessionId, terminals: Object.freeze(terminals), execution_authorized: false});
}

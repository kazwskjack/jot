type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSourceId(value: unknown): boolean {
  if (typeof value === 'string') {
    return !!value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  }
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function unsupported(): never {
  throw Error('prd_source_unsupported');
}

// Preserve the original JSON in the versioned binding, including external statuses.
function taskmasterSource(content: string) {
  let value: unknown;
  try {
    value = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
  } catch {
    return unsupported();
  }
  const groups: {tag: string; tasks: unknown[]}[] = [];
  if (Array.isArray(value)) {
    groups.push({tag: '', tasks: value});
  } else if (isRecord(value) && Array.isArray(value.tasks)) {
    groups.push({tag: '', tasks: value.tasks});
  } else if (isRecord(value)) {
    if (Object.hasOwn(value, 'tasks')) return unsupported();
    for (const [tag, group] of Object.entries(value)) {
      if (isRecord(group) && Object.hasOwn(group, 'tasks')) {
        if (!Array.isArray(group.tasks)) return unsupported();
        groups.push({tag, tasks: group.tasks});
      }
    }
  }
  if (!groups.length) return unsupported();

  const pending = groups.map(group => group.tasks);
  let taskCount = 0;
  while (pending.length) {
    const tasks = pending.pop()!;
    const ids = new Set<string>();
    for (const task of tasks) {
      if (!isRecord(task) || !isSourceId(task.id) || ids.has(String(task.id))) return unsupported();
      if (typeof task.title !== 'string' || !task.title.trim()) return unsupported();
      ids.add(String(task.id));
      taskCount++;
      for (const key of ['description', 'details', 'testStrategy', 'status', 'priority']) {
        if (task[key] !== undefined && typeof task[key] !== 'string') return unsupported();
      }
      if (task.parentId !== undefined && !isSourceId(task.parentId)) return unsupported();
      if (task.dependencies !== undefined &&
          (!Array.isArray(task.dependencies) || !task.dependencies.every(isSourceId))) return unsupported();
      if (task.subtasks !== undefined) {
        if (!Array.isArray(task.subtasks)) return unsupported();
        pending.push(task.subtasks);
      }
    }
  }
  return {value, groups, tags: groups.map(group => group.tag), task_count: taskCount};
}

export function taskmasterSourceSummary(content: string): {tags: string[]; task_count: number} {
  const {tags, task_count} = taskmasterSource(content);
  return {tags, task_count};
}

export type TaskmasterSourceTask = {tag: string; depth: number; parent_index: number | null; task: RecordValue};

/** Ordered source projection. External statuses remain source data. */
export function taskmasterSourceTasks(content: string): {tags: string[]; items: TaskmasterSourceTask[]} {
  const {groups, tags} = taskmasterSource(content);
  return {tags, items: sourceTaskRows(groups)};
}

function sourceTaskRows(groups: {tag: string; tasks: unknown[]}[]): TaskmasterSourceTask[] {
  const items: TaskmasterSourceTask[] = [];
  for (const group of groups) {
    const stack = [{tasks: group.tasks, index: 0, depth: 0, parent_index: null as number | null}];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (frame.index === frame.tasks.length) {stack.pop(); continue;}
      const task = frame.tasks[frame.index++] as RecordValue;
      const parent = items.length;
      items.push({tag: group.tag, depth: frame.depth, parent_index: frame.parent_index, task});
      if (Array.isArray(task.subtasks) && task.subtasks.length) {
        stack.push({tasks: task.subtasks, index: 0, depth: frame.depth + 1, parent_index: parent});
      }
    }
  }
  return items;
}

export type TaskmasterTaskEdit = {kind: 'add'; tag: string; task: RecordValue} | {kind: 'update'; index: number; fields: RecordValue};

/** Update a local source draft. The original file editor owns saving and CAS. */
export function editTaskmasterSource(content: string, edit: TaskmasterTaskEdit): string {
  const original = taskmasterSource(content);
  const fields = edit.kind === 'add' ? edit.task : edit.fields;
  const allowed = ['title','description','status','priority','details','dependencies'];
  if (edit.kind === 'add') allowed.push('id');
  if (!isRecord(fields) || !Object.keys(fields).length || Object.keys(fields).some(key => !allowed.includes(key))) return unsupported();
  // Preserve unedited number literals, including large metadata integers and -0.
  const existing = JSON.stringify([original.value, fields]);
  let prefix: string;
  do {prefix = 'jot-json-number-' + crypto.randomUUID() + '-';} while (existing.includes(prefix));
  const numbers: string[] = [];
  const protectedContent = content.replace(/("(?:[^"\\]|\\[\s\S])*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (token, quoted) => {
    if (quoted !== undefined) return token;
    numbers.push(token);
    return JSON.stringify(prefix + (numbers.length - 1));
  });
  const parsed = taskmasterSource(protectedContent);
  if (edit.kind === 'add') {
    const group = parsed.groups.find(group => group.tag === edit.tag);
    if (!group || !isSourceId(fields.id) || typeof fields.title !== 'string' || !fields.title.trim()
      || typeof fields.description !== 'string' || !fields.description.trim()) return unsupported();
    group.tasks.push({...fields});
  } else if (edit.kind === 'update') {
    if (!Number.isSafeInteger(edit.index) || edit.index < 0) return unsupported();
    const row = sourceTaskRows(parsed.groups)[edit.index];
    if (!row) return unsupported();
    Object.assign(row.task, fields);
  } else return unsupported();
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const restoreNumbers = (serialized: string) => serialized.replace(new RegExp('"' + prefix + '(\\d+)"', 'g'), (token, index) => numbers[Number(index)] ?? token);
  const bom = content.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  let result = bom + restoreNumbers(JSON.stringify(parsed.value, null, 2)).replace(/\n/g, eol) + eol;
  if (new TextEncoder().encode(result).byteLength > 1048576) result = bom + restoreNumbers(JSON.stringify(parsed.value)) + eol;
  if (new TextEncoder().encode(result).byteLength > 1048576) throw Error('taskmaster_source_too_large');
  taskmasterSourceSummary(result);
  return result;
}

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
export function taskmasterSourceSummary(content: string): {tags: string[]; task_count: number} {
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
  return {tags: groups.map(group => group.tag), task_count: taskCount};
}

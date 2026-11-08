const validIdentity=identity=>identity&&typeof identity.task_id==='string'&&identity.task_id.length>0&&identity.task_id.length<=200&&
 typeof identity.occurrence_id==='string'&&identity.occurrence_id.length>0&&identity.occurrence_id.length<=200;

export function findOwnedTask(tasks,identity){
 if(!validIdentity(identity)||!Array.isArray(tasks))return null;
 return tasks.find(task=>task?.task_id===identity.task_id)??null;
}

export function findOwnedOccurrence(occurrences,identity){
 if(!validIdentity(identity)||!Array.isArray(occurrences))return null;
 return occurrences.find(occurrence=>occurrence?.task_id===identity.task_id&&occurrence.occurrence_id===identity.occurrence_id)??null;
}

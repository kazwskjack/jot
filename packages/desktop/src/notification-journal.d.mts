export type NotificationIdentity={event_id:string;task_id:string;occurrence_id:string;generation:number;event_kind:'changed'|'completed'|'failed'|'needs_confirmation'};
export type NotificationPending={identity:NotificationIdentity;state:'queued'|'dispatching'|'unknown'|'observing'|'shown'|'ending'};
export type NotificationJournal={version:2;cursor:string|null;baseline:string;pending:NotificationPending[];ended:NotificationIdentity[]};
export function notificationJournalScope(value:unknown):string;
export function notificationIdentity(value:unknown):NotificationIdentity;
export function normalizeNotificationJournal(value:unknown):NotificationJournal;
export function endNotificationWait(value:NotificationJournal,eventIds:readonly string[]):NotificationJournal;

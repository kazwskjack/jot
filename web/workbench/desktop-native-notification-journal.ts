import {normalizeNotificationJournal,notificationJournalScope,type NotificationJournal} from '../../packages/desktop/src/notification-journal.mjs';
export type JournalTransport={read:(scope:string)=>Promise<unknown>;write:(scope:string,revision:number,journal:NotificationJournal)=>Promise<unknown>;adopt:(scope:string,journal:NotificationJournal)=>Promise<unknown>};
type Receipt={revision:number;journal:NotificationJournal|null};
function receipt(value:unknown,scope:string):Receipt{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('desktop_notification_journal_invalid');
 const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='journal,protocol,revision,scope'||row.protocol!==1||row.scope!==scope||typeof row.revision!=='number'||!Number.isSafeInteger(row.revision)||row.revision<0||(row.revision===0)!==(row.journal===null))throw Error('desktop_notification_journal_invalid');
 return {revision:row.revision,journal:row.journal===null?null:normalizeNotificationJournal(row.journal)};
}
export class NativeDesktopNotificationJournal{
 private constructor(private readonly transport:JournalTransport,private readonly scope:string,private current:Receipt){}
 static async open(transport:JournalTransport,scope:string,legacy:NotificationJournal|null){
  notificationJournalScope(scope);const value=receipt(await transport.read(scope),scope);
  const adopted=legacy?receipt(await transport.adopt(scope,legacy),scope):value;
  if(legacy&&(!adopted.journal||adopted.revision<value.revision))throw Error('desktop_notification_journal_invalid');
  return new NativeDesktopNotificationJournal(transport,scope,adopted);
 }
 read(){return this.current.journal;}
 async save(value:NotificationJournal){
  const normalized=normalizeNotificationJournal(value),expected=this.current.revision;
  const next=receipt(await this.transport.write(this.scope,expected,normalized),this.scope);
  if(next.revision!==expected+1||!next.journal||JSON.stringify(next.journal)!==JSON.stringify(normalized))throw Error('desktop_notification_journal_unconfirmed');
  this.current=next;
 }
}

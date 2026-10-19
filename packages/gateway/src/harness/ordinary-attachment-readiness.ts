export type OrdinaryAttachmentSteeringClient={steeringAttachmentsReadiness(signal?:AbortSignal):Promise<unknown>};
/** Composition readiness only; never opens a Session or grants execution. */
export async function readAttachmentSteeringReadiness(enabled:boolean,client?:OrdinaryAttachmentSteeringClient,signal?:AbortSignal):Promise<boolean>{
 if(!enabled||typeof client?.steeringAttachmentsReadiness!=='function')return false;
 try{const value=await client.steeringAttachmentsReadiness(signal);if(!value||typeof value!=='object'||Array.isArray(value))return false;const row=value as Record<string,unknown>;return Object.keys(row).sort().join(',')==='execution_authorized,protocol,ready'&&row.protocol===1&&row.ready===true&&row.execution_authorized===false;}catch{return false;}
}

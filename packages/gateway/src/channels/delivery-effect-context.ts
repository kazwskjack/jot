import {createHash} from 'node:crypto';
export type DeliveryEffectContext=Readonly<{effectId:string;generation:number;idempotencyKey:string}>;
export type DeliveryFilePart=Readonly<{artifactId:string;version:number;manifestSha256:string;partIndex:number;partSha256:string;partSizeBytes:number;displayName:string}>;
export type FileDeliveryEffectContext=DeliveryEffectContext&Readonly<{filePart:DeliveryFilePart}>;
function fail():never{throw Error('channel_delivery_context_invalid');}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function base(effectId:unknown,generation:unknown){if(typeof effectId!=='string'||!/^[A-Za-z0-9._:-]{1,255}$/.test(effectId)||!Number.isSafeInteger(generation)||Number(generation)<1)fail();return{effectId,generation:Number(generation)};}
function partIdentity(value:unknown):DeliveryFilePart{
 if(!object(value)||Object.keys(value).sort().join(',')!=='artifactId,displayName,manifestSha256,partIndex,partSha256,partSizeBytes,version'
  ||typeof value.artifactId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.artifactId)||!Number.isSafeInteger(value.version)||Number(value.version)<1
  ||typeof value.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(value.manifestSha256)||typeof value.partSha256!=='string'||!/^[a-f0-9]{64}$/.test(value.partSha256)
  ||!Number.isSafeInteger(value.partIndex)||Number(value.partIndex)<1||Number(value.partIndex)>50||!Number.isSafeInteger(value.partSizeBytes)||Number(value.partSizeBytes)<1||Number(value.partSizeBytes)>104857600
  ||typeof value.displayName!=='string'||!value.displayName||value.displayName.length>255||/[\\/\u0000-\u001f\u007f]/u.test(value.displayName))fail();
 return Object.freeze({artifactId:value.artifactId,version:Number(value.version),manifestSha256:value.manifestSha256,partIndex:Number(value.partIndex),partSha256:value.partSha256,partSizeBytes:Number(value.partSizeBytes),displayName:value.displayName});
}
function partKey(effectId:string,part:DeliveryFilePart){
 // Lease generations fence authority; they must not create new transaction keys.
 return 'jot-file-'+createHash('sha256').update(JSON.stringify(['file-effect-v1',effectId,part.artifactId,part.version,part.manifestSha256,part.partIndex,part.partSha256,part.partSizeBytes,part.displayName])).digest('hex');
}
export function fileDeliveryContext(effectId:string,generation:number,input:DeliveryFilePart):FileDeliveryEffectContext{
 const source=base(effectId,generation),part=partIdentity(input);return Object.freeze({...source,idempotencyKey:partKey(source.effectId,part),filePart:part});
}
export function requireTextDeliveryContext(input:unknown):DeliveryEffectContext{
 if(!object(input)||Object.keys(input).sort().join(',')!=='effectId,generation,idempotencyKey')fail();
 const source=base(input.effectId,input.generation);if(input.idempotencyKey!==source.effectId)fail();return Object.freeze({...source,idempotencyKey:source.effectId});
}
export function requireFileDeliveryContext(input:unknown):FileDeliveryEffectContext{
 if(!object(input)||Object.keys(input).sort().join(',')!=='effectId,filePart,generation,idempotencyKey')fail();
 const source=base(input.effectId,input.generation),context=fileDeliveryContext(source.effectId,source.generation,partIdentity(input.filePart));if(input.idempotencyKey!==context.idempotencyKey)fail();return context;
}

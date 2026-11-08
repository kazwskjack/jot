import type {ChannelAVerificationConfig} from './channel-a-runtime.ts';
import {isMatrixAdapter} from './matrix.ts';

type Row=Record<string,unknown>;
const fail=():never=>{throw Error('channel_ingress_config_invalid');};
const record=(value:unknown):value is Row=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function object(value:unknown,keys:readonly string[]):Row{
  if(!record(value)||Object.keys(value).some(key=>!keys.includes(key)))return fail();
  return value;
}
function text(row:Row,key:string,min=1,max=4096):string{
  const value=row[key];
  if(typeof value!=='string'||Buffer.byteLength(value)<min||Buffer.byteLength(value)>max||/[\u0000-\u001f\u007f]/u.test(value))return fail();
  return value;
}
function optionalText(row:Row,key:string):{[name:string]:string}{
  return row[key]===undefined?{}:{[key]:text(row,key)};
}
function integer(row:Row,key:string,min:number,max:number):number|undefined{
  const value=row[key];if(value===undefined)return;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)return fail();
  return value;
}
function skew(row:Row):{maxSkewSeconds?:number}{
  const value=integer(row,'maxSkewSeconds',1,3600);return value===undefined?{}:{maxSkewSeconds:value};
}
function size(row:Row):{maxAttachmentBytes?:number}{
  const value=integer(row,'maxAttachmentBytes',1,104857600);return value===undefined?{}:{maxAttachmentBytes:value};
}
function hosts(row:Row):{attachmentHosts?:readonly string[]}{
  if(row.attachmentHosts===undefined)return {};
  if(!Array.isArray(row.attachmentHosts))return fail();
  const result=row.attachmentHosts.map(value=>{
    if(typeof value!=='string'||!value||value.length>253||value!==value.trim())return fail();
    let url:URL;try{url=new URL('https://'+value);}catch{return fail();}
    if(url.hostname!==value||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash)return fail();
    return value;
  });
  if(new Set(result).size!==result.length)return fail();
  return {attachmentHosts:Object.freeze(result)};
}

/** Validates the module's configured protocols, not an owner grant or provider event. */
export function validateChannelAConfiguration(value:unknown):ChannelAVerificationConfig{
  if(!record(value))return fail();
  const result:ChannelAVerificationConfig={};
  for(const [channel,raw] of Object.entries(value)){
    switch(channel){
      case 'api-server': {
        const row=object(raw,['secret','maxSkewSeconds','maxAttachmentBytes','attachmentHosts']);
        result[channel]=Object.freeze({secret:text(row,'secret',32),...skew(row),...size(row),...hosts(row)});break;
      }
      case 'bluebubbles': {
        const row=object(raw,['secret','serverId']);
        result[channel]=Object.freeze({secret:text(row,'secret',32),...optionalText(row,'serverId')});break;
      }
      case 'cli': {
        const row=object(raw,['token']);result[channel]=Object.freeze({token:text(row,'token',32)});break;
      }
      case 'dingtalk': {
        const row=object(raw,['token','aesKey','ownerKey','maxSkewSeconds']);
        const token=text(row,'token',3,32),aesKey=text(row,'aesKey',43,43);
        if(!/^[A-Za-z0-9]+$/.test(token)||!/^[A-Za-z0-9+/]{43}$/.test(aesKey)||Buffer.from(aesKey+'=','base64').length!==32)return fail();
        result[channel]=Object.freeze({token,aesKey,ownerKey:text(row,'ownerKey',1,512),...skew(row)});break;
      }
      case 'discord': {
        const row=object(raw,['publicKey','maxSkewSeconds']),publicKey=text(row,'publicKey',64,64);
        if(!/^[a-f0-9]{64}$/i.test(publicKey))return fail();
        result[channel]=Object.freeze({publicKey,...skew(row)});break;
      }
      case 'email': {
        const row=object(raw,['secret','maxSkewSeconds','maxAttachmentBytes','attachmentHosts']);
        result[channel]=Object.freeze({secret:text(row,'secret',32),...skew(row),...size(row),...hosts(row)});break;
      }
      case 'feishu': {
        const row=object(raw,['verificationToken','encryptKey','maxSkewSeconds']);
        result[channel]=Object.freeze({verificationToken:text(row,'verificationToken'),...optionalText(row,'encryptKey'),...skew(row)});break;
      }
      case 'homeassistant': {
        const row=object(raw,['webhookId','binding']),binding=object(row.binding,['principal','threadId']);
        const principal=text(binding,'principal',1,128),threadId=text(binding,'threadId',1,128);
        if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(principal)||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(threadId))return fail();
        result[channel]=Object.freeze({webhookId:text(row,'webhookId',32),binding:Object.freeze({principal,threadId})});break;
      }
      case 'matrix': {
        const row=object(raw,['client']);if(!isMatrixAdapter(row.client))return fail();
        result[channel]=Object.freeze({client:row.client});break;
      }
      case 'mattermost': {
        const row=object(raw,['token']);result[channel]=Object.freeze({token:text(row,'token',16)});break;
      }
      default:return fail();
    }
  }
  return Object.freeze(result);
}

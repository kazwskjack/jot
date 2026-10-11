import type {DeliveryProvider} from './worker.ts';
export type EmailConfig={host:string;port:number;secure:boolean;user:string;password:string;from:string;ca?:string};
type Transport={sendMail(message:Record<string,unknown>):Promise<Record<string,any>>};
type Factory=(options:Record<string,unknown>)=>Promise<Transport>;
export function emailPrincipal(value:unknown):string{
 if(typeof value!=='string'||value.length>254||value!==value.trim()||/[\s,;<>\r\n]/.test(value))throw new Error('email_address_invalid');
 const parts=value.split('@');if(parts.length!==2)throw new Error('email_address_invalid');
 const [local,domain]=parts as [string,string];
 if(!local||local.length>64||local.startsWith('.')||local.endsWith('.')||local.includes('..')||! /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)||!domain.includes('.')||domain.split('.').some(label=>! /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))throw new Error('email_address_invalid');
 return `${local}@${domain.toLowerCase()}`;
}
export async function createEmailProvider(config:EmailConfig,factory:Factory=async options=>{
 const module=await import('nodemailer');return module.default.createTransport(options as any) as Transport;
}):Promise<DeliveryProvider>{
 if(!config||typeof config.host!=='string'||! /^[A-Za-z0-9.-]{1,253}$/.test(config.host)||!config.host.includes('.')||!((config.port===465&&config.secure===true)||(config.port===587&&config.secure===false))||typeof config.user!=='string'||!config.user.trim()||typeof config.password!=='string'||!config.password)throw new Error('email_config_invalid');
 const from=emailPrincipal(config.from);
 if(config.ca!==undefined&&(typeof config.ca!=='string'||!config.ca.includes('-----BEGIN CERTIFICATE-----')))throw new Error('email_ca_invalid');
 const transport=await factory({host:config.host,port:config.port,secure:config.secure,requireTLS:!config.secure,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2',...(config.ca?{ca:config.ca}:{})},auth:{user:config.user,pass:config.password},pool:false,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000});
 return {async send(text,recipient){
  const to=emailPrincipal(recipient);if(typeof text!=='string'||!text.trim()||text.length>120000)throw new Error('email_content_invalid');
  let receipt:Record<string,any>;
  try{receipt=await transport.sendMail({from,to,envelope:{from,to:[to]},subject:'Jot task update',text,disableFileAccess:true,disableUrlAccess:true});}
  catch{throw new Error('network_email_delivery_ambiguous');}
  try{if(typeof receipt.messageId!=='string'||!receipt.messageId||!Array.isArray(receipt.accepted)||receipt.accepted.length!==1||emailPrincipal(receipt.accepted[0])!==to||(receipt.rejected?.length??0)>0)throw new Error('unconfirmed');}catch{throw new Error('network_email_provider_receipt_unconfirmed');}
  return {provider_message_id:receipt.messageId};
 },async sendFile(){throw new Error('email_attachment_not_enabled');}};
}

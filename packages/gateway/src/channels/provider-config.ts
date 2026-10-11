import { readFileSync } from 'node:fs';
import { emailPrincipal, type EmailConfig } from './email-provider.ts';
type Environment=Record<string,string|undefined>;
export function deliveryChannels(env:Environment):Array<'wecom'|'email'>{
 const channels=(env.GENERAL_AGENT_DELIVERY_CHANNELS??'wecom').split(',').map(value=>value.trim());
 if(!channels.length||new Set(channels).size!==channels.length||channels.some(value=>value!=='wecom'&&value!=='email'))throw new Error('delivery_channels_invalid');
 return channels as Array<'wecom'|'email'>;
}
export function emailConfiguration(env:Environment,read:(path:string)=>string=path=>readFileSync(path,'utf8')):EmailConfig{
 const host=env.GENERAL_AGENT_SMTP_HOST?.trim()??'';
 const port=Number(env.GENERAL_AGENT_SMTP_PORT??465);
 const user=env.GENERAL_AGENT_SMTP_USER?.trim()??'';
 const secretFile=env.GENERAL_AGENT_SMTP_PASSWORD_FILE?.trim()??'';
 let from:string;
 try{from=emailPrincipal(env.GENERAL_AGENT_SMTP_FROM);}catch{throw new Error('email_config_invalid');}
 if(!/^[A-Za-z0-9.-]{1,253}$/.test(host)||!host.includes('.')||![465,587].includes(port)||!user||!secretFile)throw new Error('email_config_invalid');
 let password:string;
 try{password=read(secretFile).replace(/[\r\n]+$/,'');}catch{throw new Error('email_secret_unavailable');}
 if(!password||/[\r\n]/.test(password))throw new Error('email_config_invalid');
 return {host,port,secure:port===465,user,password,from};
}

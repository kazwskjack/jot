import { readFileSync } from 'node:fs';
import { emailPrincipal, type EmailConfig } from './email-provider.ts';
type Environment=Record<string,string|undefined>;
const ACCOUNT_SID=/^AC[0-9a-fA-F]{32}$/;
const API_KEY_SID=/^SK[0-9a-fA-F]{32}$/;
type DeliveryChannel='wecom'|'email'|'webpush'|'mattermost'|'slack'|'sms';
export function deliveryChannels(env:Environment):DeliveryChannel[]{
 const channels=(env.GENERAL_AGENT_DELIVERY_CHANNELS??'wecom').split(',').map(value=>value.trim());
  if(!channels.length||new Set(channels).size!==channels.length||channels.some(value=>value!=='wecom'&&value!=='email'&&value!=='webpush'&&value!=='mattermost'&&value!=='slack'&&value!=='sms'))throw new Error('delivery_channels_invalid');
  return channels as DeliveryChannel[];
}
export function requireDeliveryRuntimeConfiguration(channels:readonly DeliveryChannel[],runtimeBaseUrl:string,runtimeSecretFile:string):void{
 if(channels.some(channel=>channel==='wecom'||channel==='mattermost'||channel==='slack')&&(!runtimeBaseUrl.trim()||!runtimeSecretFile.trim()))throw new Error('delivery_runtime_config_required');
}

export interface SlackWebhookRuntimeConfig { teamId:string; signingSecret:string; appId?:string; botUserId:string; attachmentBotToken?:string; }
export interface SlackDeliveryRuntimeConfig { teamId:string; botToken:string; }
const SLACK_ID=/^[A-Za-z0-9._-]{1,80}$/;

export function slackWebhookConfiguration(env:Environment,read:(path:string)=>string=path=>readFileSync(path,'utf8')):SlackWebhookRuntimeConfig|undefined{
 const teamId=env.GENERAL_AGENT_SLACK_TEAM_ID?.trim()??'';
 const secretFile=env.GENERAL_AGENT_SLACK_SIGNING_SECRET_FILE?.trim()??'';
 const appId=env.GENERAL_AGENT_SLACK_APP_ID?.trim()??'';
 const botUserId=env.GENERAL_AGENT_SLACK_BOT_USER_ID?.trim()??'';
 if(!teamId&&!secretFile&&!appId&&!botUserId)return undefined;
 if(!SLACK_ID.test(teamId)||!secretFile||(appId&&!SLACK_ID.test(appId))||!SLACK_ID.test(botUserId))throw new Error('slack_config_invalid');
 const attachments=env.GENERAL_AGENT_SLACK_ATTACHMENTS_ENABLED??'false';
 if(!['true','false'].includes(attachments))throw new Error('slack_config_invalid');
 let signingSecret:string;try{signingSecret=read(secretFile).replace(/[\r\n]+$/,'');}catch{throw new Error('slack_secret_unavailable');}
 if(Buffer.byteLength(signingSecret,'utf8')<32||Buffer.byteLength(signingSecret,'utf8')>4096||/[\r\n]/.test(signingSecret))throw new Error('slack_config_invalid');
 return {teamId,signingSecret,...(appId?{appId}:{}),botUserId,
  ...(attachments==='true'?{attachmentBotToken:slackDeliveryConfiguration(env,read).botToken}:{})};
}

export function slackDeliveryConfiguration(env:Environment,read:(path:string)=>string=path=>readFileSync(path,'utf8')):SlackDeliveryRuntimeConfig{
 const teamId=env.GENERAL_AGENT_SLACK_TEAM_ID?.trim()??'';const tokenFile=env.GENERAL_AGENT_SLACK_BOT_TOKEN_FILE?.trim()??'';
 if(!SLACK_ID.test(teamId)||!tokenFile)throw new Error('slack_config_invalid');
 let botToken:string;try{botToken=read(tokenFile).replace(/[\r\n]+$/,'');}catch{throw new Error('slack_secret_unavailable');}
 if(!/^xoxb-[A-Za-z0-9_-]{8,4096}$/.test(botToken))throw new Error('slack_config_invalid');
 return {teamId,botToken};
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

export function smsWebhookConfiguration(env:Environment,read:(path:string)=>string=path=>readFileSync(path,'utf8')):
 {accountSid:string;authToken:string;webhookUrl:string;apiKeySid:string;apiKeySecret:string}|undefined{
 const accountSid=env.GENERAL_AGENT_TWILIO_ACCOUNT_SID?.trim()??'';
 const tokenFile=env.GENERAL_AGENT_TWILIO_AUTH_TOKEN_FILE?.trim()??'';
 const webhookUrl=env.GENERAL_AGENT_TWILIO_WEBHOOK_URL?.trim()??'';
 const apiKeySid=env.GENERAL_AGENT_TWILIO_API_KEY_SID?.trim()??'';
 const apiSecretFile=env.GENERAL_AGENT_TWILIO_API_KEY_SECRET_FILE?.trim()??'';
 if(!accountSid&&!tokenFile&&!webhookUrl&&!apiKeySid&&!apiSecretFile)return;
 if(!ACCOUNT_SID.test(accountSid)||!tokenFile||!webhookUrl||webhookUrl.length>2048
   ||!API_KEY_SID.test(apiKeySid)||!apiSecretFile)throw new Error('sms_webhook_config_invalid');
 let parsed:URL;try{parsed=new URL(webhookUrl);}catch{throw new Error('sms_webhook_config_invalid');}
 if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)throw new Error('sms_webhook_config_invalid');
 let authToken:string,apiKeySecret:string;
 try{authToken=read(tokenFile).replace(/[\r\n]+$/,'');}catch{throw new Error('sms_webhook_secret_unavailable');}
 try{apiKeySecret=read(apiSecretFile).replace(/[\r\n]+$/,'');}catch{throw new Error('sms_webhook_secret_unavailable');}
 if(!authToken||authToken.length>4096||/[\r\n]/.test(authToken)
   ||!apiKeySecret||apiKeySecret.length>4096||/[\r\n]/.test(apiKeySecret))throw new Error('sms_webhook_config_invalid');
 return {accountSid,authToken,webhookUrl,apiKeySid,apiKeySecret};
}

export function smsDeliveryConfiguration(env:Environment,read:(path:string)=>string=path=>readFileSync(path,'utf8')):
 {accountSid:string;apiKeySid:string;apiKeySecret:string}{
 const accountSid=env.GENERAL_AGENT_TWILIO_ACCOUNT_SID?.trim()??'';
 const apiKeySid=env.GENERAL_AGENT_TWILIO_API_KEY_SID?.trim()??'';
 const secretFile=env.GENERAL_AGENT_TWILIO_API_KEY_SECRET_FILE?.trim()??'';
 if(!ACCOUNT_SID.test(accountSid)||!API_KEY_SID.test(apiKeySid)||!secretFile)throw new Error('sms_delivery_config_invalid');
 let apiKeySecret:string;try{apiKeySecret=read(secretFile).replace(/[\r\n]+$/,'');}catch{throw new Error('sms_delivery_secret_unavailable');}
 if(!apiKeySecret||apiKeySecret.length>4096||/[\r\n]/.test(apiKeySecret))throw new Error('sms_delivery_config_invalid');
 return {accountSid,apiKeySid,apiKeySecret};
}

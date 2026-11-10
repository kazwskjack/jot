import {createHmac,timingSafeEqual} from 'node:crypto';
import type {OfficePrintView} from '../../contracts/types.ts';

type OriginalSource={conversationId:string;runId:string;activityId:string;resultSha:string;
 file:{path:string;version:number;sha256:string;size:number}};
type DerivedPdf=Pick<OfficePrintView,'sha256'|'size'|'pageCount'>;

export function signOfficePrintProof(key:string,owner:string,source:OriginalSource,pdf:DerivedPdf):string{
 if(typeof key!=='string'||key.length<16)throw Error('office_print_reference_unproven');
 const file=source.file;
 const binding=['jot-office-print/v1',owner,source.conversationId,source.runId,source.activityId,source.resultSha,
  file.path,file.version,file.sha256,file.size,pdf.sha256,pdf.size,pdf.pageCount];
 return createHmac('sha256',key).update(JSON.stringify(binding)).digest('base64url');
}

/** Call only after the shared structural reference codec succeeds. */
export function assertOfficePrintProof(key:string|undefined,owner:string,value:Record<string,unknown>){
 if(value.print_view===undefined)return;
 const source=value as unknown as OriginalSource&{print_view:DerivedPdf&{proof:string}};
 const actual=source.print_view.proof;
 if(typeof key!=='string'||typeof actual!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(actual))throw Error('office_print_reference_unproven');
 const expected=signOfficePrintProof(key,owner,source,source.print_view);
 if(!timingSafeEqual(Buffer.from(actual,'ascii'),Buffer.from(expected,'ascii')))throw Error('office_print_reference_unproven');
}

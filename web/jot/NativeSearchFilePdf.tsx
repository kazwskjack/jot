import React from 'react';
import ActivityToolFilePdf from './ActivityToolFilePdf';
import type {FileViewingIdentity} from './activity-file-preview-client';
import type {OfficePrintView} from '../../packages/gateway/contracts/types';
import type {PdfReferenceFocus} from './pdf-file-view-state';

type PrintViewingIdentity=Omit<OfficePrintView,'proof'>&{proof?:string|undefined};
/** All verified native openings reuse the complete PDF controller; quote authority remains separate. */
export default function NativeSearchFilePdf({bytes,expectedPageCount,source,printView,focus,onRetry}:{bytes:Uint8Array;expectedPageCount?:number|undefined;source?:FileViewingIdentity|undefined;printView?:PrintViewingIdentity|undefined;focus?:PdfReferenceFocus|undefined;onRetry?:()=>void}){
 if(!source?.native_source)return <p role="alert">PDF打开来源尚未确认，请重新打开文件。</p>;
 if(expectedPageCount!==undefined&&printView?.pageCount!==expectedPageCount)return <p role="alert">转换PDF页数与来源结果不一致，请重新读取转换预览。</p>;
 return <ActivityToolFilePdf {...source} openedBytes={bytes} focus={focus}
  officePrint={printView?{...printView,bytes,onRetry:onRetry??(()=>{}),focus}:undefined}/>;
}

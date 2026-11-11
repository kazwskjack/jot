import React from 'react';
import ActivityToolFileDocx from './ActivityToolFileDocx';
import ActivityToolFileXlsx from './ActivityToolFileXlsx';
import ActivityToolFilePptx from './ActivityToolFilePptx';
import type {FileViewingIdentity} from './activity-file-preview-client';
import type {OfficeCellFocus,OfficeTextFocus,OfficeRegionFocus} from './FileTextReferences';

type Kind='docx'|'xlsx'|'pptx';
/** Verified native bytes share the complete Office controllers; quote authority remains separate. */
export default function NativeSearchFileOffice({kind,bytes,source,officeFocus,officeTextFocus,officeRegionFocus}:{kind:Kind;bytes:Uint8Array;source?:FileViewingIdentity|undefined;officeFocus?:OfficeCellFocus|undefined;officeTextFocus?:OfficeTextFocus|undefined;officeRegionFocus?:OfficeRegionFocus|undefined}){
 if(!source?.native_source)return <p role="alert">Office打开来源尚未确认，请重新打开文件。</p>;
 const input={...source,openedBytes:bytes};
 return kind==='docx'?<ActivityToolFileDocx {...input} officeTextFocus={officeTextFocus} officeRegionFocus={officeRegionFocus}/>:kind==='xlsx'?<ActivityToolFileXlsx {...input} officeFocus={officeFocus} officeRegionFocus={officeRegionFocus}/>:<ActivityToolFilePptx {...input} officeRegionFocus={officeRegionFocus}/>;
}

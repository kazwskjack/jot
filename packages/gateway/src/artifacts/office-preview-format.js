// Format families/MIMEs follow PilotDeck 783499ff binaryFile.ts and FileArtifactCollector.ts.
// AGPL-3.0 notice retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt.
export const OFFICE_PRINT_SOURCE_MAX_BYTES=100*1024*1024;
const formats={
 docx:['docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',true],
 doc:['docx','application/msword',false],
 wps:['docx','application/vnd.ms-works',false],
 odt:['docx','application/vnd.oasis.opendocument.text',false],
 xlsx:['xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',true],
 xls:['xlsx','application/vnd.ms-excel',false],
 et:['xlsx','application/vnd.ms-excel',false],
 ods:['xlsx','application/vnd.oasis.opendocument.spreadsheet',false],
 pptx:['pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation',true],
 ppt:['pptx','application/vnd.ms-powerpoint',false],
 dps:['pptx','application/vnd.ms-powerpoint',false],
 odp:['pptx','application/vnd.oasis.opendocument.presentation',false],
};
export function officePreviewFormat(path){
 if(typeof path!=='string')return undefined;
 const extension=path.toLowerCase().split('.').at(-1);
 if(!Object.hasOwn(formats,extension))return undefined;
 const [kind,mediaType,native]=formats[extension];
 return {kind,mediaType,native,extension};
}

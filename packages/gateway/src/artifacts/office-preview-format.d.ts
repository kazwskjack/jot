type OfficePreviewFormat={kind:'docx'|'xlsx'|'pptx';mediaType:string;native:boolean;extension:string};
export function officePreviewFormat(path:unknown):OfficePreviewFormat|undefined;

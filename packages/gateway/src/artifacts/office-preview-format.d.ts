export const OFFICE_SOURCE_MAX_BYTES:number;
export const OFFICE_PRINT_SOURCE_MAX_BYTES:number;
export const OFFICE_NATIVE_SOURCE_MAX_BYTES:number;
type OfficePreviewFormat={kind:'docx'|'xlsx'|'pptx';mediaType:string;native:boolean;extension:string};
export function officePreviewFormat(path:unknown):OfficePreviewFormat|undefined;

export const OFFICE_PRINT_SOURCE_MAX_BYTES:number;
type OfficePreviewFormat={kind:'docx'|'xlsx'|'pptx';mediaType:string;native:boolean;extension:string};
export function officePreviewFormat(path:unknown):OfficePreviewFormat|undefined;

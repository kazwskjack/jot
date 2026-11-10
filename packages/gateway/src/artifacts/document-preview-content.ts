const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const isRecord = (value:unknown):value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const plainText = (value:unknown) => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
};
const normalizedType = (value:unknown) => String(value ?? '').toLowerCase().split(';', 1)[0]!.trim();

export function isDocumentPreviewMediaType(value:unknown) {
  return DOCUMENT_TYPES.has(normalizedType(value));
}

function pagesText(content:Record<string,unknown>) {
  if (typeof content.page_count !== 'number' || !Number.isSafeInteger(content.page_count) || content.page_count < 0 || !Array.isArray(content.pages)) {
    throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
  }
  return content.pages.map((page, index) => {
    if (!isRecord(page) || typeof page.number !== 'number' || !Number.isSafeInteger(page.number) || page.number < 1) {
      throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
    }
    return `第 ${page.number} 页\n${plainText(page.text)}`;
  }).join('\n\n');
}

function docxText(content:Record<string,unknown>) {
  if (!Array.isArray(content.paragraphs) || !Array.isArray(content.tables)) throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
  const parts = content.paragraphs.map(plainText);
  for (const table of content.tables) {
    if (!Array.isArray(table) || table.some(row => !Array.isArray(row))) throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
    for (const row of table) parts.push(row.map(plainText).join(' | '));
  }
  return parts.join('\n');
}

function spreadsheetText(content:Record<string,unknown>) {
  if (!Array.isArray(content.sheets)) throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
  const parts = [];
  for (const sheet of content.sheets) {
    if (!isRecord(sheet) || typeof sheet.name !== 'string' || !isRecord(sheet.cells)) throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
    parts.push(`工作表：${sheet.name}`);
    const cells = Object.entries(sheet.cells).sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
    for (const [address, cell] of cells) {
      if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(address) || !isRecord(cell)) throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
      const value = plainText(cell.value ?? '');
      const formula = cell.formula == null ? '' : ` [=${plainText(cell.formula)}]`;
      parts.push(`${address}: ${value}${formula}`);
    }
  }
  return parts.join('\n');
}

function slidesText(content:Record<string,unknown>) {
  if (!Array.isArray(content.slides)) throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
  return content.slides.map(slide => {
    if (!isRecord(slide) || typeof slide.number !== 'number' || !Number.isSafeInteger(slide.number) || slide.number < 1) throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
    return `幻灯片 ${slide.number}\n${plainText(slide.text)}`;
  }).join('\n\n');
}

export function formatDocumentPreviewContent(mediaType:unknown, content:unknown, maxChars = 200_000) {
  const type = normalizedType(mediaType);
  if (!DOCUMENT_TYPES.has(type) || !isRecord(content) || !Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error('DOCUMENT_PREVIEW_RESULT_INVALID');
  }
  let text;
  if (type === 'application/pdf') text = pagesText(content);
  else if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') text = docxText(content);
  else if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') text = spreadsheetText(content);
  else text = slidesText(content);
  return Object.freeze({ text: text.slice(0, maxChars), truncated: content.truncated === true || text.length > maxChars });
}

/** Adapt the original document.read result shape without rewriting saved evidence. */
export function formatDocumentReadContent(mediaType:unknown,content:unknown,maxChars=8*1024*1024){
 if(!isRecord(content)||normalizedType(content.media_type)!==normalizedType(mediaType)
  ||content.text_reader_revision!==undefined&&content.text_reader_revision!==1)throw Error('DOCUMENT_PREVIEW_RESULT_INVALID');
 let normalized=content;
 if(normalizedType(mediaType)==='application/pdf'){
  if(typeof content.page_count!=='number'||!Number.isSafeInteger(content.page_count)||content.page_count<0
   ||!Array.isArray(content.pages)||content.pages.length!==content.page_count||content.pages.some(page=>typeof page!=='string'))throw Error('DOCUMENT_PREVIEW_RESULT_INVALID');
  normalized={...content,pages:content.pages.map((text,index)=>({number:index+1,text}))};
 }
 const formatted=formatDocumentPreviewContent(mediaType,normalized,maxChars);
 return {text:formatted.text,truncated:formatted.truncated||content.text_reader_revision!==1};
}


export type SpreadsheetRawValue=string|number|boolean|null;
export type SpreadsheetPreviewCell={value:string;formula:string|null;raw_value?:SpreadsheetRawValue};
export type OfficeDocumentPreview=
 |{kind:'docx';paragraphs:string[];tables:string[][][];truncated:boolean}
 |{kind:'xlsx';sheets:Array<{name:string;cells:Record<string,SpreadsheetPreviewCell>}>;truncated:boolean}
 |{kind:'pptx';slides:Array<{number:number;text:string}>;truncated:boolean};

const officeTypes={
 docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;
export function officePreviewFormat(path:string){
 const extension=path.toLowerCase().split('.').at(-1);
 if(extension!=='docx'&&extension!=='xlsx'&&extension!=='pptx')return undefined;
 return {kind:extension,mediaType:officeTypes[extension]};
}

function spreadsheetPreviewCell(cell:Record<string,unknown>):SpreadsheetPreviewCell{
 const normalized:SpreadsheetPreviewCell={value:plainText(cell.value??''),formula:cell.formula==null?null:plainText(cell.formula)};
 if(Object.hasOwn(cell,'raw_value')){
  const raw=cell.raw_value;
  if(raw!==null&&typeof raw!=='boolean'&&!(typeof raw==='number'&&Number.isFinite(raw))&&!(typeof raw==='string'&&raw.length<=100000))throw Error('DOCUMENT_PREVIEW_RESULT_INVALID');
  normalized.raw_value=raw as SpreadsheetRawValue;
 }
 return normalized;
}

/** Share the existing engine-content checks, and expose bounded file data. */
export function normalizeOfficePreviewContent(mediaType:string,content:unknown):OfficeDocumentPreview{
 const formatted=formatDocumentPreviewContent(mediaType,content);
 if(mediaType===officeTypes.docx){
  const value=content as {paragraphs:unknown[];tables:unknown[][][]};
  return {kind:'docx',paragraphs:value.paragraphs.map(plainText),tables:value.tables.map((table:unknown[][])=>table.map(row=>row.map(plainText))),truncated:formatted.truncated};
 }
 if(mediaType===officeTypes.xlsx){
  const value=content as {sheets:Array<{name:string;cells:Record<string,Record<string,unknown>>}>};
  if(value.sheets.some(sheet=>sheet.name.length>512))throw Error('DOCUMENT_PREVIEW_RESULT_INVALID');
  const sheets=value.sheets.map((sheet:{name:string;cells:Record<string,Record<string,unknown>>})=>({
   name:sheet.name,cells:Object.fromEntries(Object.entries(sheet.cells).map(([address,cell])=>[
    address,spreadsheetPreviewCell(cell),
   ])),
  }));
  return {kind:'xlsx',sheets,truncated:formatted.truncated};
 }
 if(mediaType!==officeTypes.pptx)throw Error('DOCUMENT_PREVIEW_RESULT_INVALID');
 const value=content as {slides:Array<{number:number;text:unknown}>};
 return {kind:'pptx',slides:value.slides.map((slide:{number:number;text:unknown})=>({number:slide.number,text:plainText(slide.text)})),truncated:formatted.truncated};
}

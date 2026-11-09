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

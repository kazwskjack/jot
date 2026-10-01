export const FILE_OPERATIONS = [
  'document.inspect', 'document.read',
  'writer.fill_template', 'writer.replace_text', 'writer.set_table_cell',
  'calc.fill_records', 'calc.set_cells', 'calc.recalculate',
  'office.export_pdf',
  'pdf.reorder_pages', 'pdf.rotate_pages',
  'file.job_status',
] as const;
export type FileOperation = typeof FILE_OPERATIONS[number];

export interface FileOperationRequest {
  operation: FileOperation;
  base_version: number;
  base_sha256: string;
  target?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  change?: Record<string, unknown>;
  save_as?: { format: string; new_version: true };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function unoCellName(columnIndex: number, rowIndex: number): string {
  if (!Number.isInteger(columnIndex) || columnIndex < 0 || !Number.isInteger(rowIndex) || rowIndex < 0) {
    throw new Error('FILE_REQUEST_INVALID');
  }
  let value = columnIndex + 1; let column = '';
  while (value > 0) { value -= 1; column = String.fromCharCode(65 + (value % 26)) + column; value = Math.floor(value / 26); }
  return `${column}${rowIndex + 1}`;
}

function normalizeWriterRequest(result: FileOperationRequest): void {
  const target = asRecord(result.target); const expected = asRecord(result.expected); const change = asRecord(result.change);
  if (result.operation === 'writer.replace_text') {
    const oldText = String(target.old_text ?? target.find_text ?? '');
    const newText = change.new_text;
    const expectedMatches = Number(target.expected_matches ?? expected.match_count ?? 1);
    if (!oldText || typeof newText !== 'string' || !Number.isInteger(expectedMatches) || expectedMatches < 1) {
      throw new Error('FILE_REQUEST_INVALID');
    }
    result.target = { old_text: oldText, expected_matches: expectedMatches };
    result.change = { new_text: newText };
  }
  if (result.operation === 'writer.set_table_cell') {
    const tableIndex = Number(target.table_index ?? 0);
    const cell = String(target.cell ?? (target.row_index !== undefined && target.column_index !== undefined
      ? unoCellName(Number(target.column_index), Number(target.row_index)) : ''));
    const value = change.value ?? change.new_text;
    if (!Number.isInteger(tableIndex) || tableIndex < 0 || !/^[A-Z]+[1-9][0-9]*$/.test(cell)
      || (typeof value !== 'string' && typeof value !== 'number')) throw new Error('FILE_REQUEST_INVALID');
    result.target = { table_index: tableIndex, cell };
    const oldValue = target.old_value ?? expected.old_text;
    if (oldValue !== undefined) result.target.old_value = String(oldValue);
    result.change = { value: String(value) };
  }
  if (result.operation === 'writer.replace_text' || result.operation === 'writer.set_table_cell') {
    if (result.save_as && result.save_as.format !== 'docx') throw new Error('UNSUPPORTED_FORMAT_OPERATION');
    result.save_as = { format: 'docx', new_version: true };
  }
}

export function validateFileOperationRequest(input: Record<string, unknown>): FileOperationRequest {
  const operation = String(input.operation || '') as FileOperation;
  if (!FILE_OPERATIONS.includes(operation)) throw new Error('UNSUPPORTED_FORMAT_OPERATION');
  const baseVersion = Number(input.base_version);
  if (!Number.isInteger(baseVersion) || baseVersion < 1) throw new Error('STALE_FILE_VERSION');
  const baseSha256 = String(input.base_sha256 || '');
  if (!/^[a-f0-9]{64}$/.test(baseSha256)) throw new Error('STALE_FILE_VERSION');
  const result: FileOperationRequest = { operation, base_version: baseVersion, base_sha256: baseSha256 };
  for (const key of ['target', 'expected', 'change'] as const) {
    const value = input[key];
    if (value !== undefined) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('FILE_REQUEST_INVALID');
      result[key] = value as Record<string, unknown>;
    }
  }
  if (input.save_as !== undefined) {
    const value = input.save_as as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.new_version !== true) throw new Error('FILE_REQUEST_INVALID');
    result.save_as = { format: String(value.format || '').toLowerCase(), new_version: true };
  }
  normalizeWriterRequest(result);
  if (operation === 'office.export_pdf' && result.save_as?.format !== 'pdf') {
    throw new Error('UNSUPPORTED_FORMAT_OPERATION');
  }
  if (operation === 'writer.fill_template' && result.save_as?.format !== 'docx') {
    throw new Error('UNSUPPORTED_FORMAT_OPERATION');
  }
  if (operation === 'calc.fill_records' && result.save_as?.format !== 'xlsx') {
    throw new Error('UNSUPPORTED_FORMAT_OPERATION');
  }
  return result;
}

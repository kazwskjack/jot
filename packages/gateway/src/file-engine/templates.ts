import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RegisteredTemplate {
  template_id: string;
  version: string;
  format: 'docx' | 'xlsx';
  sha256: string;
  fields: Record<string, { token: string; max_chars: number }>;
  mapping?: string;
  path: string;
  mapping_path?: string;
}

export class TemplateContractError extends Error {
  readonly details: Record<string, unknown>;
  constructor(code: string, details: Record<string, unknown>) {
    super(code); this.name = 'TemplateContractError'; this.details = structuredClone(details);
  }
}

export class TemplateCatalog {
  private readonly templates: RegisteredTemplate[];

  constructor(root: string) {
    const directory = resolve(root);
    const value = JSON.parse(readFileSync(resolve(directory, 'catalog.json'), 'utf8')) as
      { templates?: Array<Record<string, unknown>> };
    if (!Array.isArray(value.templates) || !value.templates.length) throw new Error('TEMPLATE_CATALOG_INVALID');
    this.templates = value.templates.map(raw => {
      const file = String(raw.file || ''); const path = resolve(directory, file);
      if (!file || !existsSync(path)) throw new Error('TEMPLATE_NOT_FOUND');
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (sha256 !== String(raw.sha256 || '')) throw new Error('TEMPLATE_HASH_MISMATCH');
      const format = String(raw.format || '');
      if (!['docx', 'xlsx'].includes(format)) throw new Error('TEMPLATE_CATALOG_INVALID');
      const mapping = raw.mapping ? String(raw.mapping) : undefined;
      const mappingPath = mapping ? resolve(directory, mapping) : undefined;
      if (mappingPath && !existsSync(mappingPath)) throw new Error('TEMPLATE_NOT_FOUND');
      return { template_id: String(raw.template_id || ''), version: String(raw.version || ''),
        format: format as 'docx' | 'xlsx', sha256,
        fields: (raw.fields && typeof raw.fields === 'object' ? raw.fields : {}) as RegisteredTemplate['fields'],
        ...(mapping ? { mapping } : {}), path, ...(mappingPath ? { mapping_path: mappingPath } : {}) };
    });
  }

  list(): Array<Omit<RegisteredTemplate, 'path' | 'mapping_path'> & { fill_contract: Record<string, unknown> }> {
    return this.templates.map(({ path: _path, mapping_path: _mappingPath, ...row }) => structuredClone({
      ...row,
      fill_contract: {
        operation: row.format === 'docx' ? 'writer.fill_template' : 'calc.fill_records',
        target: { template_id: row.template_id, template_version: row.version, template_sha256: row.sha256 },
        required_fields: Object.keys(row.fields),
        ...(row.mapping ? { record_schema: 'evidence-records/1.0', mapping: row.mapping } : {}),
        save_as: { format: row.format, new_version: true },
      },
    }));
  }

  resolve(templateId: string, version: string, sha256: string): RegisteredTemplate {
    const row = this.templates.find(item => item.template_id === templateId
      && item.version === version && item.sha256 === sha256);
    if (!row) throw new Error('TEMPLATE_NOT_FOUND');
    return structuredClone(row);
  }

  validateFields(template: RegisteredTemplate, value: unknown): Record<string, string> {
    const required = Object.keys(template.fields);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TemplateContractError('TEMPLATE_CONTENT_INVALID', { missing_fields: required, unexpected_fields: [] });
    }
    const fields = value as Record<string, unknown>; const expected = Object.keys(template.fields).sort();
    const actual = Object.keys(fields); const missing = expected.filter(key => !actual.includes(key));
    const unexpected = actual.filter(key => !expected.includes(key));
    if (missing.length || unexpected.length) throw new TemplateContractError('TEMPLATE_CONTENT_INVALID', {
      missing_fields: missing, unexpected_fields: unexpected,
    });
    const result: Record<string, string> = {};
    const invalid: string[] = [];
    for (const key of expected) {
      const text = fields[key]; const limit = Number(template.fields[key]?.max_chars || 0);
      if (typeof text !== 'string' || !text.trim() || !Number.isInteger(limit) || limit < 1 || text.length > limit) {
        invalid.push(key); continue;
      }
      result[key] = text;
    }
    if (invalid.length) throw new TemplateContractError('TEMPLATE_CONTENT_INVALID', { invalid_fields: invalid });
    return result;
  }

  validateRecords(template: RegisteredTemplate, change: unknown): Record<string, unknown> {
    if (template.format !== 'xlsx' || !template.mapping_path) throw new Error('TEMPLATE_CONTENT_INVALID');
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('TEMPLATE_CONTENT_INVALID');
    const value = change as Record<string, unknown>;
    if (value.schema_version !== 'evidence-records/1.0' || !Array.isArray(value.records)) {
      throw new Error('TEMPLATE_CONTENT_INVALID');
    }
    const mapping = JSON.parse(readFileSync(template.mapping_path, 'utf8')) as Record<string, any>;
    if (value.records.length > Number(mapping.capacity)) throw new Error('TEMPLATE_CONTENT_INVALID');
    const columns = Object.keys(mapping.columns).sort(); const seen = new Set<string>();
    const records = value.records.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('TEMPLATE_CONTENT_INVALID');
      const record = raw as Record<string, unknown>;
      if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(columns)) throw new Error('TEMPLATE_CONTENT_INVALID');
      if (!['verified', 'partial', 'missing', 'synthetic'].includes(String(record.verification))) {
        throw new Error('TEMPLATE_CONTENT_INVALID');
      }
      const natural = (mapping.natural_key as string[]).map(key => String(record[key] ?? '')).join('\u0000');
      if (!natural.replaceAll('\u0000', '') || seen.has(natural)) throw new Error('TEMPLATE_CONTENT_INVALID');
      seen.add(natural);
      if (record.verification === 'verified'
        && (!/^https?:\/\//.test(String(record.source_url || '')) || !String(record.evidence_ref || '').trim())) {
        throw new Error('TEMPLATE_CONTENT_INVALID');
      }
      if (record.verification === 'missing' && record.value !== null) throw new Error('TEMPLATE_CONTENT_INVALID');
      return structuredClone(record);
    });
    return { schema_version: value.schema_version, records };
  }
}

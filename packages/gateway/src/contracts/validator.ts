import { readFileSync } from 'node:fs';
import * as Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import * as AddFormatsModule from 'ajv-formats';

const Ajv2020 = (Ajv2020Module as unknown as { default: new (options?: Record<string, unknown>) => {
  addSchema(schema: unknown, key: string): void; compile(schema: unknown): ValidateFunction;
} }).default;
const addFormats = (AddFormatsModule as unknown as { default: (ajv: unknown) => void }).default;

interface OperationValidators {
  request?: ValidateFunction;
  responses: Map<number, ValidateFunction>;
}

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

export class ContractValidator {
  private readonly operations = new Map<string, OperationValidators>();
  private readonly routes = new Map<string, string>();
  readonly compilationErrors: string[] = [];

  constructor(spec: Record<string, any> = JSON.parse(readFileSync(
    new URL('../../contracts/openapi.json', import.meta.url), 'utf8',
  ))) {
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
    addFormats(ajv);
    for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
      ajv.addSchema(schema, `#/components/schemas/${name}`);
    }
    for (const [path, item] of Object.entries(spec.paths ?? {}) as Array<[string, Record<string, any>]>) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        const operation = item[method];
        if (!operation?.operationId) continue;
        const validators: OperationValidators = { responses: new Map() };
        try {
          const requestSchema = operation.requestBody?.content?.['application/json']?.schema;
          if (requestSchema) validators.request = ajv.compile(requestSchema);
          for (const [status, response] of Object.entries(operation.responses ?? {}) as Array<[string, any]>) {
            const schema = response?.content?.['application/json']?.schema;
            if (schema && /^\d{3}$/.test(status)) validators.responses.set(Number(status), ajv.compile(schema));
          }
        } catch (error) {
          this.compilationErrors.push(`${operation.operationId}:${error instanceof Error ? error.message : 'compile_failed'}`);
        }
        this.operations.set(String(operation.operationId), validators);
        this.routes.set(`${method.toUpperCase()} ${this.routeShape(path)}`, String(operation.operationId));
      }
    }
  }

  get operationCount(): number { return this.operations.size; }

  operationFor(method: string, routePath: string): string | null {
    return this.routes.get(`${method.toUpperCase()} ${this.routeShape(routePath)}`) ?? null;
  }

  validateRequest(operationId: string, value: unknown): ValidationResult {
    const operation = this.get(operationId);
    if (!operation.request) return { valid: true, errors: [] };
    return this.run(operation.request, value);
  }

  validateResponse(operationId: string, status: number, value: unknown): ValidationResult {
    const operation = this.get(operationId);
    const validator = operation.responses.get(status);
    if (!validator) return { valid: true, errors: [] };
    return this.run(validator, value);
  }

  private get(operationId: string): OperationValidators {
    const value = this.operations.get(operationId);
    if (!value) throw new Error('contract_operation_unknown');
    return value;
  }

  private run(validator: ValidateFunction, value: unknown): ValidationResult {
    const valid = Boolean(validator(value));
    return { valid, errors: valid ? [] : [...(validator.errors ?? [])] };
  }

  private routeShape(path: string): string {
    return path.replace(/\{[^}]+\}|:[A-Za-z0-9_]+/g, '{}');
  }
}

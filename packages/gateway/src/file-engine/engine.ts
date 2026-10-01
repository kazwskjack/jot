import { spawn } from 'node:child_process';

export function fileEngineChildEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    PATH: environment.PATH ?? '',
    PYTHONPATH: environment.PYTHONPATH ?? '',
    GENERAL_AGENT_FILE_ENGINE_TEMPLATE_ROOT: environment.GENERAL_AGENT_FILE_ENGINE_TEMPLATE_ROOT ?? '',
    GENERAL_AGENT_LIBREOFFICE: environment.GENERAL_AGENT_LIBREOFFICE?.trim() || '/usr/bin/libreoffice',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
}

export interface FileEngineInput {
  operation: string;
  input_path: string;
  output_path?: string;
  media_type: string;
  job_dir: string;
  request: Record<string, unknown>;
}

export interface FileEngineResult {
  ok: boolean;
  engine: { name: string; version: string };
  content?: any;
  output_path?: string;
  checks?: Record<string, unknown>;
  warnings?: string[];
  error_code?: string;
}

export class FileEngineAdapter {
  private readonly python: string;
  private readonly workerPath: string;
  private readonly timeoutMs: number;
  constructor(options: { python: string; workerPath: string; timeoutMs?: number }) {
    this.python = options.python; this.workerPath = options.workerPath;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  run(input: FileEngineInput): Promise<FileEngineResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, [this.workerPath], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: fileEngineChildEnvironment(),
      });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      child.stdout.on('data', value => stdout.push(Buffer.from(value)));
      child.stderr.on('data', value => stderr.push(Buffer.from(value)));
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ENGINE_TIMEOUT')); }, this.timeoutMs);
      child.once('error', () => { clearTimeout(timer); reject(new Error('ENGINE_CRASH')); });
      child.once('close', code => {
        clearTimeout(timer);
        let value: FileEngineResult;
        try { value = JSON.parse(Buffer.concat(stdout).toString('utf8')) as FileEngineResult; }
        catch { reject(new Error(code === 0 ? 'ENGINE_RESULT_INVALID' : 'ENGINE_CRASH')); return; }
        if (!value.ok) reject(new Error(value.error_code || 'ENGINE_CRASH'));
        else resolve(value);
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}

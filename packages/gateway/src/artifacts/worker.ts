import type { GeneratedArtifactReceipt } from './requests.ts';

interface ArtifactRequestStore {
  claim(owner: string, leaseSeconds: number): Record<string, any> | null;
  recordGenerated(requestId: string, generation: number, receipt: GeneratedArtifactReceipt): void;
  recordReceiptFailure(requestId: string, reasonCode: string): void;
  recordVerified(requestId: string): void;
}

interface ArtifactRenderer {
  render(request: Record<string, unknown>): Promise<GeneratedArtifactReceipt>;
}

interface ArtifactRuntime {
  registerArtifactReceipt(runtimeRunId: string, expectedClientRunId: string,
    receipt: { request_id: string; artifact_ref: string; size_bytes: number;
      sha256: string; render_status: 'passed' | 'verified' }): Promise<Record<string, unknown>>;
}

export class ArtifactRequestWorker {
  private readonly store: ArtifactRequestStore;
  private readonly renderer: ArtifactRenderer;
  private readonly runtime: ArtifactRuntime;
  private readonly workerId: string;
  private readonly leaseSeconds: number;

  constructor(store: ArtifactRequestStore, renderer: ArtifactRenderer, runtime: ArtifactRuntime,
    options: { workerId: string; leaseSeconds: number }) {
    this.store = store;
    this.renderer = renderer;
    this.runtime = runtime;
    this.workerId = options.workerId;
    this.leaseSeconds = options.leaseSeconds;
  }

  async processNext(): Promise<boolean> {
    const job = this.store.claim(this.workerId, this.leaseSeconds);
    if (!job) return false;
    let receipt: GeneratedArtifactReceipt;
    if (job.phase === 'render') {
      receipt = await this.renderer.render({
        request_id: job.request_id,
        client_run_id: job.client_run_id,
        format: job.format,
        template: job.template,
        source_results: JSON.parse(String(job.source_results_json)),
      });
      this.store.recordGenerated(String(job.request_id), Number(job.generation), receipt);
    } else if (job.phase === 'receipt_only' && job.receipt) {
      receipt = job.receipt as GeneratedArtifactReceipt;
    } else {
      throw new Error('artifact_worker_state_invalid');
    }
    try {
      const result = await this.runtime.registerArtifactReceipt(
        String(job.runtime_run_id), String(job.client_run_id), {
          request_id: String(job.request_id), artifact_ref: receipt.artifact_ref,
          size_bytes: receipt.size_bytes, sha256: receipt.sha256,
          render_status: receipt.render_status,
        }
      );
      if (result.ok !== true || result.status !== 'artifact_verified'
        || result.artifact_ref !== receipt.artifact_ref) {
        throw new Error('ARTIFACT_RECEIPT_REJECTED');
      }
      this.store.recordVerified(String(job.request_id));
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'RUNTIME_TRANSPORT_UNAVAILABLE';
      this.store.recordReceiptFailure(String(job.request_id), reason.slice(0, 96));
      throw error;
    }
  }
}

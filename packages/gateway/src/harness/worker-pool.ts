export function parseWorkerConcurrency(value: string | undefined): number {
  const parsed = Number(value ?? '1');
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
  return Math.min(5, parsed);
}

type ProcessResult = { run_id: string; runtime_status: string } | null;

export async function runWorkerPool(options: {
  concurrency: number;
  pollMs: number;
  processNext: (slot: number) => Promise<ProcessResult>;
  shouldStop: () => boolean;
  onError?: (error: unknown, slot: number) => void;
}): Promise<void> {
  const concurrency = parseWorkerConcurrency(String(options.concurrency));
  const pollMs = Math.max(1, options.pollMs);
  const sleep = () => new Promise(resolve => setTimeout(resolve, pollMs));
  const runSlot = async (slot: number) => {
    while (!options.shouldStop()) {
      try {
        const claimed = await options.processNext(slot);
        if (!claimed && !options.shouldStop()) await sleep();
      } catch (error) {
        options.onError?.(error, slot);
        if (!options.shouldStop()) await sleep();
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, slot) => runSlot(slot)));
}


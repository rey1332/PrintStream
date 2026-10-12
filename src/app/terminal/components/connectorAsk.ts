import { TerminalApiError, terminalApi } from '@/lib/terminal/client';

/**
 * Asks the worker about a connection (a database's tables or a source's
 * columns; an API's endpoints or an endpoint's first page) and waits for the answer.
 */
export async function askWorker<T>(connectionId: string, source: unknown): Promise<T> {
  const { jobId } = await terminalApi<{ jobId: string }>('connection.describe', {
    id: connectionId,
    source,
  });
  for (let i = 0; i < 120; i += 1) {
    await new Promise((r) => setTimeout(r, i < 6 ? 500 : 1000));
    const job = await terminalApi<{ status: string; result: T; error_key: string | null }>(
      'job.get',
      { id: jobId }
    );
    if (job.status === 'succeeded') return job.result;
    if (job.status === 'failed' || job.status === 'cancelled')
      throw new TerminalApiError(job.error_key ?? 'failed');
  }
  throw new TerminalApiError('workerSlow');
}

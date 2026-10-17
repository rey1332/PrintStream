// The jobs list of the Terminal: repeated jobs folded into one line, filters,
// and which jobs can be run again (as ps_job_retryable in
// db/migrations/20261012000055_terminal_jobs_health_mcp.sql).

export const RETRYABLE_KINDS: readonly string[] = [
  'pipeline.run',
  'connector.sync',
  'connector.test',
  'connector.describe',
  'ai.test',
  'dataset.export',
  'import.analyze',
];

export interface JobLike {
  id: string;
  kind: string;
  status: string;
  error_key: string | null;
  created_at: string;
  pipeline_id?: string | null;
  dataset_id?: string | null;
  import_id?: string | null;
  connection_id?: string | null;
  provider_id?: string | null;
}

export const canRetry = (job: Pick<JobLike, 'kind' | 'status'>) =>
  (job.status === 'failed' || job.status === 'cancelled') && RETRYABLE_KINDS.includes(job.kind);

/** What a job worked on, so jobs of the same thing fold together. */
const targetOf = (j: JobLike) =>
  j.pipeline_id ?? j.dataset_id ?? j.import_id ?? j.connection_id ?? j.provider_id ?? '';

export interface JobGroup<J extends JobLike> {
  /** The newest job of the group: the one shown. */
  job: J;
  /** All of them, newest first (job included). */
  jobs: J[];
}

/**
 * Jobs (newest first) with each run of the same thing that ended the same way
 * folded into one line: eight cancelled "Check AI provider" in a row become
 * one line with ×8. Jobs still queued or running are never folded.
 */
export function groupJobs<J extends JobLike>(jobs: J[]): JobGroup<J>[] {
  const groups: JobGroup<J>[] = [];
  for (const j of jobs) {
    const last = groups.at(-1);
    const live = j.status === 'queued' || j.status === 'running';
    if (
      last &&
      !live &&
      last.job.kind === j.kind &&
      last.job.status === j.status &&
      (last.job.error_key ?? '') === (j.error_key ?? '') &&
      targetOf(last.job) === targetOf(j)
    ) {
      last.jobs.push(j);
    } else {
      groups.push({ job: j, jobs: [j] });
    }
  }
  return groups;
}

export type JobFilter = { status: 'all' | 'problems' | 'active' | 'succeeded'; kind: string };

export function filterJobs<J extends JobLike>(jobs: J[], filter: JobFilter): J[] {
  return jobs.filter((j) => {
    if (filter.kind !== 'all' && !j.kind.startsWith(filter.kind)) return false;
    switch (filter.status) {
      case 'problems':
        return j.status === 'failed' || j.status === 'cancelled';
      case 'active':
        return j.status === 'queued' || j.status === 'running' || j.status === 'awaiting_approval';
      case 'succeeded':
        return j.status === 'succeeded';
      default:
        return true;
    }
  });
}

/** The families of job kinds present, for the kind filter ("pipeline", "connector", …). */
export function kindFamilies(jobs: JobLike[]): string[] {
  return [...new Set(jobs.map((j) => j.kind.split('.')[0]))].sort();
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRetry, filterJobs, groupJobs, kindFamilies } from '../../src/lib/terminal/jobs.ts';

let n = 0;
const job = (kind, status, extra = {}) => ({
  id: `j${++n}`,
  kind,
  status,
  error_key: null,
  created_at: new Date(2026, 9, 12, 12, 0, 60 - n).toISOString(),
  ...extra,
});

test('repeated jobs that ended the same way fold into one line', () => {
  const p = { provider_id: 'p1' };
  const jobs = [
    job('pipeline.run', 'running', { pipeline_id: 'a' }),
    ...Array.from({ length: 5 }, () =>
      job('ai.test', 'cancelled', { ...p, error_key: 'cancelled_by_user' })
    ),
    job('import.analyze', 'cancelled', { import_id: 'i1' }),
    ...Array.from({ length: 3 }, () =>
      job('ai.test', 'cancelled', { ...p, error_key: 'cancelled_by_user' })
    ),
    job('ai.test', 'failed', { ...p, error_key: 'provider_down' }),
    job('ai.test', 'cancelled', { provider_id: 'other', error_key: 'cancelled_by_user' }),
  ];
  const groups = groupJobs(jobs);
  assert.deepEqual(
    groups.map((g) => [g.job.kind, g.job.status, g.jobs.length]),
    [
      ['pipeline.run', 'running', 1],
      ['ai.test', 'cancelled', 5],
      ['import.analyze', 'cancelled', 1],
      ['ai.test', 'cancelled', 3],
      ['ai.test', 'failed', 1],
      ['ai.test', 'cancelled', 1],
    ]
  );
  // The newest of a group is the one shown.
  assert.equal(groups[1].job.id, groups[1].jobs[0].id);
});

test('jobs still waiting or running are never folded', () => {
  const groups = groupJobs([
    job('pipeline.run', 'queued', { pipeline_id: 'a' }),
    job('pipeline.run', 'queued', { pipeline_id: 'a' }),
  ]);
  assert.equal(groups.length, 2);
});

test('filters by problem / active / succeeded and by kind; retries only failed or cancelled repeatable work', () => {
  const jobs = [
    job('pipeline.run', 'failed'),
    job('pipeline.run', 'succeeded'),
    job('connector.sync', 'running'),
    job('import.commit', 'cancelled'),
    job('ai.test', 'awaiting_approval'),
  ];
  const kinds = (f) => filterJobs(jobs, f).map((j) => `${j.kind}:${j.status}`);
  assert.deepEqual(kinds({ status: 'problems', kind: 'all' }), [
    'pipeline.run:failed',
    'import.commit:cancelled',
  ]);
  assert.deepEqual(kinds({ status: 'active', kind: 'all' }), [
    'connector.sync:running',
    'ai.test:awaiting_approval',
  ]);
  assert.deepEqual(kinds({ status: 'all', kind: 'pipeline' }), [
    'pipeline.run:failed',
    'pipeline.run:succeeded',
  ]);
  assert.deepEqual(kindFamilies(jobs), ['ai', 'connector', 'import', 'pipeline']);
  assert.deepEqual(jobs.map(canRetry), [true, false, false, false, false]);
  assert.equal(canRetry({ kind: 'ai.test', status: 'cancelled' }), true);
});

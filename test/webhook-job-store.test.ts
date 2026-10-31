import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, test } from 'vitest';

import { settleWebhookJob } from '../src/handlers/webhook-job-runner.js';
import {
  FileWebhookJobStore,
  WEBHOOK_JOB_LEASE_MS,
  type NormalizedPullRequestEvent,
} from '../src/handlers/webhook-job-store.js';

const event: NormalizedPullRequestEvent = {
  deliveryId: 'delivery-crash',
  action: 'opened',
  owner: 'test-org',
  repo: 'test-repo',
  prNumber: 42,
  headSha: 'abc',
  githubAccountId: '12345',
  githubUsername: 'test-contributor',
  installationId: '2',
  draft: false,
  fork: false,
  defaultBranch: 'main',
};

const directories: string[] = [];

function journal(): { directory: string; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heka-webhook-jobs-'));
  directories.push(directory);
  return { directory, file: path.join(directory, 'webhook-jobs.json') };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('webhook job journal', () => {
  test('a restarted worker creates one check for an abandoned job', async () => {
    const { file } = journal();
    const crashedAt = Date.now() - WEBHOOK_JOB_LEASE_MS - 1;
    await new FileWebhookJobStore(file).accept(event, crashedAt);

    const restarted = new FileWebhookJobStore(file);
    const abandoned = await restarted.leaseAbandoned(Date.now());
    expect(abandoned.map((job) => job.deliveryId)).toEqual(['delivery-crash']);
    expect(abandoned[0]?.checkRunId).toBeUndefined();

    let created = 0;
    let attached: string | undefined;
    await settleWebhookJob(abandoned[0]!, restarted, {
      ensureCheck: async () => {
        created += 1;
        return '42';
      },
      attach: async (checkRunId) => {
        attached = checkRunId;
      },
    });

    expect(created).toBe(1);
    expect(attached).toBe('42');

    const afterRestart = new FileWebhookJobStore(file);
    expect(await afterRestart.leaseAbandoned(Date.now())).toEqual([]);
    await expect(afterRestart.peek('delivery-crash')).resolves.toMatchObject({
      status: 'completed',
      checkRunId: '42',
    });
  });

  test('a restarted worker attaches the saved check and does not create another', async () => {
    const { file } = journal();
    const crashedAt = Date.now() - WEBHOOK_JOB_LEASE_MS - 1;
    const crashed = new FileWebhookJobStore(file);
    await crashed.accept(event, crashedAt);
    await crashed.recordCheck(event.deliveryId, '42');

    const restarted = new FileWebhookJobStore(file);
    const abandoned = await restarted.leaseAbandoned(Date.now());
    expect(abandoned[0]?.checkRunId).toBe('42');

    let created = 0;
    await settleWebhookJob(abandoned[0]!, restarted, {
      ensureCheck: async (existing) => {
        if (!existing) created += 1;
        return existing ?? '99';
      },
      attach: async (checkRunId) => {
        expect(checkRunId).toBe('42');
      },
    });

    expect(created).toBe(0);
    await expect(new FileWebhookJobStore(file).peek('delivery-crash')).resolves.toMatchObject({
      status: 'completed',
      checkRunId: '42',
    });
  });

  test('a second delivery inside the lease does not start another job', async () => {
    const { file } = journal();
    const store = new FileWebhookJobStore(file);
    const now = Date.now();
    await expect(store.accept(event, now)).resolves.toMatchObject({ disposition: 'run' });
    await expect(store.accept(event, now + 1_000)).resolves.toMatchObject({ disposition: 'skip', status: 'processing' });
  });
});

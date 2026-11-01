import fs from 'fs';
import os from 'os';
import path from 'path';

import nock from 'nock';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { startAbandonedJobRecovery, WEBHOOK_RECOVERY_INTERVAL_MS } from '../src/handlers/webhook-recovery.js';
import { settleWebhookJob } from '../src/handlers/webhook-job-runner.js';
import {
  DurableWebhookJobStore,
  FileWebhookJobStore,
  WEBHOOK_JOB_LEASE_MS,
  type NormalizedPullRequestEvent,
  type WebhookJobRecord,
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
  vi.useRealTimers();
  nock.cleanAll();
  nock.enableNetConnect();
  delete process.env.HEKA_STATUS_TOKEN;
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

  test('a running worker retries a failed attach after the lease without creating another check', async () => {
    vi.useFakeTimers();
    const { file } = journal();
    let now = 1_700_000_000_000;
    const store = new FileWebhookJobStore(file);
    await store.accept(event, now);
    const first = await store.peek(event.deliveryId);
    let created = 0;
    let attaches = 0;

    const settle = (job: WebhookJobRecord) =>
      settleWebhookJob(job, store, {
        ensureCheck: async (existing) => {
          if (!existing) created += 1;
          return existing ?? '42';
        },
        attach: async () => {
          attaches += 1;
          if (attaches === 1) throw new Error('attach failed');
        },
      });

    await expect(settle(first!)).rejects.toThrow('attach failed');
    expect(created).toBe(1);

    const recovery = startAbandonedJobRecovery(
      async (at) => {
        const abandoned = await store.leaseAbandoned(at);
        for (const job of abandoned) await settle(job);
      },
      { now: () => now, intervalMs: WEBHOOK_RECOVERY_INTERVAL_MS },
    );
    await recovery.tick();
    expect(attaches).toBe(1);

    now += WEBHOOK_JOB_LEASE_MS + 1;
    await vi.advanceTimersByTimeAsync(WEBHOOK_RECOVERY_INTERVAL_MS);
    await recovery.tick();
    recovery.stop();

    expect(created).toBe(1);
    expect(attaches).toBe(2);
    await expect(store.peek(event.deliveryId)).resolves.toMatchObject({
      status: 'completed',
      checkRunId: '42',
    });
  });

  test('remote finish fails, App restarts, job resolves without a duplicate check', async () => {
    process.env.HEKA_STATUS_TOKEN = 'test-status-token';
    nock.disableNetConnect();
    const { file } = journal();
    const crashedAt = Date.now() - WEBHOOK_JOB_LEASE_MS - 1;
    nock('http://localhost:3000')
      .patch('/v2/presentation-session/deliveries/delivery-crash')
      .reply(200)
      .patch('/v2/presentation-session/deliveries/delivery-crash')
      .reply(500)
      .patch('/v2/presentation-session/deliveries/delivery-crash')
      .reply(200);

    const running = new DurableWebhookJobStore(new FileWebhookJobStore(file));
    await running.accept(event, crashedAt);
    await running.recordCheck(event.deliveryId, '42');
    await expect(running.finish(event.deliveryId, 'completed')).rejects.toThrow();
    await expect(new FileWebhookJobStore(file).peek(event.deliveryId)).resolves.toMatchObject({
      status: 'processing',
      checkRunId: '42',
    });

    const restarted = new DurableWebhookJobStore(new FileWebhookJobStore(file));
    const abandoned = await restarted.leaseAbandoned(Date.now());
    expect(abandoned.map((job) => job.deliveryId)).toEqual(['delivery-crash']);
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
    await expect(new FileWebhookJobStore(file).peek(event.deliveryId)).resolves.toMatchObject({
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

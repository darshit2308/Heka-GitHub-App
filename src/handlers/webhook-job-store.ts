import fs from 'fs';
import path from 'path';

import {
  finishWebhookJob,
  leaseAbandonedWebhookJobs,
  recordWebhookCheck,
  acceptWebhookJob,
} from '../services/hekaService.js';

export const WEBHOOK_JOB_LEASE_MS = 2 * 60 * 1000;

export type WebhookJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface NormalizedPullRequestEvent {
  deliveryId: string;
  action: 'opened' | 'synchronize' | 'reopened' | 'ready_for_review' | 'closed';
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  githubAccountId: string;
  githubUsername: string;
  installationId: string;
  draft: boolean;
  fork: boolean;
  defaultBranch?: string;
}

export interface WebhookJobRecord {
  deliveryId: string;
  event: NormalizedPullRequestEvent;
  status: WebhookJobStatus;
  checkRunId?: string;
  leaseUntil: number;
}

export interface WebhookJobDecision {
  disposition: 'run' | 'skip';
  status: WebhookJobStatus;
  checkRunId?: string;
}

export interface WebhookJobStore {
  accept(event: NormalizedPullRequestEvent, now: number): Promise<WebhookJobDecision>;
  recordCheck(deliveryId: string, checkRunId: string): Promise<void>;
  finish(deliveryId: string, status: 'completed' | 'failed'): Promise<void>;
  /** Drops a local row when another worker owns the live lease. */
  forget(deliveryId: string): Promise<void>;
  leaseAbandoned(now: number): Promise<WebhookJobRecord[]>;
  peek(deliveryId: string): Promise<WebhookJobRecord | undefined>;
}

function clone(job: WebhookJobRecord): WebhookJobRecord {
  return {
    deliveryId: job.deliveryId,
    event: { ...job.event },
    status: job.status,
    checkRunId: job.checkRunId,
    leaseUntil: job.leaseUntil,
  };
}

/** Shared rules for the file journal and the in-memory test store. */
export function acceptJob(jobs: WebhookJobRecord[], event: NormalizedPullRequestEvent, now: number): WebhookJobDecision {
  const existing = jobs.find((job) => job.deliveryId === event.deliveryId);
  if (!existing) {
    jobs.push({
      deliveryId: event.deliveryId,
      event,
      status: 'processing',
      leaseUntil: now + WEBHOOK_JOB_LEASE_MS,
    });
    return { disposition: 'run', status: 'processing' };
  }
  if (existing.status === 'completed' || existing.status === 'failed') {
    return { disposition: 'skip', status: existing.status, checkRunId: existing.checkRunId };
  }
  if (existing.status === 'processing' && existing.leaseUntil > now) {
    return { disposition: 'skip', status: 'processing', checkRunId: existing.checkRunId };
  }
  existing.status = 'processing';
  existing.leaseUntil = now + WEBHOOK_JOB_LEASE_MS;
  existing.event = event;
  return { disposition: 'run', status: 'processing', checkRunId: existing.checkRunId };
}

export function leaseAbandonedJobs(jobs: WebhookJobRecord[], now: number): WebhookJobRecord[] {
  const due = jobs.filter(
    (job) => job.status === 'pending' || (job.status === 'processing' && job.leaseUntil <= now),
  );
  for (const job of due) {
    job.status = 'processing';
    job.leaseUntil = now + WEBHOOK_JOB_LEASE_MS;
  }
  return due.map(clone);
}

export class MemoryWebhookJobStore implements WebhookJobStore {
  private readonly jobs: WebhookJobRecord[] = [];

  public accept(event: NormalizedPullRequestEvent, now: number): Promise<WebhookJobDecision> {
    return Promise.resolve(acceptJob(this.jobs, event, now));
  }

  public recordCheck(deliveryId: string, checkRunId: string): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.deliveryId === deliveryId);
    if (job) job.checkRunId = checkRunId;
    return Promise.resolve();
  }

  public finish(deliveryId: string, status: 'completed' | 'failed'): Promise<void> {
    const job = this.jobs.find((candidate) => candidate.deliveryId === deliveryId);
    if (job) {
      job.status = status;
      job.leaseUntil = 0;
    }
    return Promise.resolve();
  }

  public forget(deliveryId: string): Promise<void> {
    const index = this.jobs.findIndex((candidate) => candidate.deliveryId === deliveryId);
    if (index >= 0) this.jobs.splice(index, 1);
    return Promise.resolve();
  }

  public leaseAbandoned(now: number): Promise<WebhookJobRecord[]> {
    return Promise.resolve(leaseAbandonedJobs(this.jobs, now));
  }

  public peek(deliveryId: string): Promise<WebhookJobRecord | undefined> {
    const job = this.jobs.find((candidate) => candidate.deliveryId === deliveryId);
    return Promise.resolve(job ? clone(job) : undefined);
  }
}

/**
 * App-side job journal. A process restart reads the same file.
 * Writes are serialized in this process. Two App processes must not share the file;
 * the identity-service row is the cross-process record.
 */
export class FileWebhookJobStore implements WebhookJobStore {
  private chain: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public accept(event: NormalizedPullRequestEvent, now: number): Promise<WebhookJobDecision> {
    return this.locked((jobs) => acceptJob(jobs, event, now));
  }

  public recordCheck(deliveryId: string, checkRunId: string): Promise<void> {
    return this.locked((jobs) => {
      const job = jobs.find((candidate) => candidate.deliveryId === deliveryId);
      if (job) job.checkRunId = checkRunId;
    });
  }

  public finish(deliveryId: string, status: 'completed' | 'failed'): Promise<void> {
    return this.locked((jobs) => {
      const job = jobs.find((candidate) => candidate.deliveryId === deliveryId);
      if (job) {
        job.status = status;
        job.leaseUntil = 0;
      }
    });
  }

  public forget(deliveryId: string): Promise<void> {
    return this.locked((jobs) => {
      const index = jobs.findIndex((candidate) => candidate.deliveryId === deliveryId);
      if (index >= 0) jobs.splice(index, 1);
    });
  }

  public leaseAbandoned(now: number): Promise<WebhookJobRecord[]> {
    return this.locked((jobs) => leaseAbandonedJobs(jobs, now));
  }

  public peek(deliveryId: string): Promise<WebhookJobRecord | undefined> {
    return this.locked((jobs) => {
      const job = jobs.find((candidate) => candidate.deliveryId === deliveryId);
      return job ? clone(job) : undefined;
    });
  }

  private read(): WebhookJobRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { jobs?: WebhookJobRecord[] };
    return parsed.jobs ?? [];
  }

  private write(jobs: WebhookJobRecord[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const next = path.join(path.dirname(this.filePath), `.${path.basename(this.filePath)}.tmp`);
    fs.writeFileSync(next, JSON.stringify({ jobs }));
    fs.renameSync(next, this.filePath);
  }

  private locked<T>(change: (jobs: WebhookJobRecord[]) => T): Promise<T> {
    const run = this.chain.then(() => {
      const jobs = this.read();
      const result = change(jobs);
      this.write(jobs);
      return result;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review', 'closed']);

function isPullRequestAction(action: string): action is NormalizedPullRequestEvent['action'] {
  return ACTIONS.has(action);
}

/**
 * File journal plus the identity-service row. The file is what a restart reads.
 * The database deduplicates across processes. The local row stays `processing`
 * until the identity service accepts `completed` or `failed`, so a failed
 * mirror is retried instead of hidden.
 */
export class DurableWebhookJobStore implements WebhookJobStore {
  public constructor(private readonly local: FileWebhookJobStore) {}

  public async accept(event: NormalizedPullRequestEvent, now: number): Promise<WebhookJobDecision> {
    const local = await this.local.accept(event, now);
    if (local.disposition === 'skip') return local;
    try {
      const remote = await acceptWebhookJob(event);
      if (remote.disposition === 'skip') {
        if (remote.status === 'completed' || remote.status === 'failed') {
          await this.local.finish(event.deliveryId, remote.status);
        } else {
          await this.local.forget(event.deliveryId);
        }
        const status: WebhookJobStatus =
          remote.status === 'completed' || remote.status === 'failed' || remote.status === 'pending'
            ? remote.status
            : 'processing';
        return { disposition: 'skip', status, checkRunId: remote.checkRunId ?? local.checkRunId };
      }
      return { disposition: 'run', status: 'processing', checkRunId: remote.checkRunId ?? local.checkRunId };
    } catch {
      return local;
    }
  }

  public async recordCheck(deliveryId: string, checkRunId: string): Promise<void> {
    await this.local.recordCheck(deliveryId, checkRunId);
    try {
      await recordWebhookCheck(deliveryId, checkRunId);
    } catch {
      // The local row keeps the id. The next resume attaches that check.
    }
  }

  public async finish(deliveryId: string, status: 'completed' | 'failed'): Promise<void> {
    await finishWebhookJob(deliveryId, status);
    await this.local.finish(deliveryId, status);
  }

  public forget(deliveryId: string): Promise<void> {
    return this.local.forget(deliveryId);
  }

  public async leaseAbandoned(now: number): Promise<WebhookJobRecord[]> {
    const local = await this.local.leaseAbandoned(now);
    const seen = new Set(local.map((job) => job.deliveryId));
    try {
      const remote = await leaseAbandonedWebhookJobs();
      for (const job of remote) {
        if (seen.has(job.deliveryId) || !isPullRequestAction(job.event.action)) continue;
        const event: NormalizedPullRequestEvent = {
          ...job.event,
          action: job.event.action,
          deliveryId: job.deliveryId,
        };
        const decision = await this.local.accept(event, now);
        if (decision.disposition === 'skip') {
          if (decision.status === 'completed' || decision.status === 'failed') {
            await this.pushTerminal(job.deliveryId, decision.status, decision.checkRunId ?? job.checkRunId);
          }
          continue;
        }
        if (job.checkRunId) await this.local.recordCheck(job.deliveryId, job.checkRunId);
        local.push({
          deliveryId: job.deliveryId,
          event,
          status: 'processing',
          checkRunId: job.checkRunId ?? decision.checkRunId,
          leaseUntil: now + WEBHOOK_JOB_LEASE_MS,
        });
      }
    } catch {
      return local;
    }
    return local;
  }

  public peek(deliveryId: string): Promise<WebhookJobRecord | undefined> {
    return this.local.peek(deliveryId);
  }

  /** Copies a local terminal row onto a remote row that is still processing. */
  private async pushTerminal(
    deliveryId: string,
    status: 'completed' | 'failed',
    checkRunId: string | undefined,
  ): Promise<void> {
    try {
      if (checkRunId) await recordWebhookCheck(deliveryId, checkRunId);
      await finishWebhookJob(deliveryId, status);
    } catch {
      // The remote lease stays in place. The next recovery tick tries again.
    }
  }
}

let jobs: WebhookJobStore = new MemoryWebhookJobStore();

export function webhookJobs(): WebhookJobStore {
  return jobs;
}

export function resetWebhookJobsForTests(): void {
  jobs = new MemoryWebhookJobStore();
}

export function installProductionWebhookJobStore(): void {
  jobs = new DurableWebhookJobStore(new FileWebhookJobStore(path.join(process.cwd(), 'data', 'webhook-jobs.json')));
}

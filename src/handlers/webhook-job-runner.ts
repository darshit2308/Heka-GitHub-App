import type { WebhookJobRecord, WebhookJobStore } from './webhook-job-store.js';

/**
 * Creates the check only when this job does not already have one, then attaches
 * it, and only then marks the job completed. A second call after completion
 * must not create another check.
 */
export async function settleWebhookJob(
  job: WebhookJobRecord,
  store: WebhookJobStore,
  actions: {
    ensureCheck: (existingCheckRunId?: string) => Promise<string>;
    attach: (checkRunId: string) => Promise<void>;
  },
): Promise<void> {
  const checkRunId = job.checkRunId ?? (await actions.ensureCheck());
  if (!job.checkRunId) await store.recordCheck(job.deliveryId, checkRunId);
  await actions.attach(checkRunId);
  await store.finish(job.deliveryId, 'completed');
}

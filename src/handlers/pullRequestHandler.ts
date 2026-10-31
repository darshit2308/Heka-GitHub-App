import { Context, Probot } from 'probot';
import { alreadyDelivered } from './delivery-memory.js';
import { settleWebhookJob } from './webhook-job-runner.js';
import {
  webhookJobs,
  type NormalizedPullRequestEvent,
  type WebhookJobDecision,
  type WebhookJobRecord,
} from './webhook-job-store.js';
import {
  attachPresentationCheckRun,
  closePresentationSessions,
  openPresentationSession,
  type PresentationSessionResult,
} from '../services/hekaService.js';

/** The canonical name used for all check runs created by this App. */
const CHECK_NAME = 'Heka Identity Verification';

/**
 * Handles `pull_request.opened`, `pull_request.synchronize`, and
 * `pull_request.reopened` webhook events.
 *
 * Flow:
 *   1. Lease the delivery. A live lease or a finished job is skipped. The job
 *      stays in progress until the check run exists and is attached. A timer
 *      in this process resumes an expired lease, so a failed attach is retried
 *      without waiting for a restart. GitHub will not redeliver an event it accepted.
 *   2. Skip when this commit already has a Heka check run, and attach that
 *      check when this delivery still owes the session a link.
 *   3. Ask the identity service for an OID4VP session. The session page is
 *      the check's `details_url`.
 *   4. Create the check as Action Required, or as success when a presentation
 *      from this GitHub account already succeeded inside the last 15 minutes.
 *   5. Store the check run id on the session. The identity service updates
 *      that check when the wallet presents, or when the session times out.
 *
 * If the identity service is unreachable, the check is completed as a failure
 * so the pull request is not left without a result.
 */
type VerificationEvent =
  | 'pull_request.opened'
  | 'pull_request.synchronize'
  | 'pull_request.reopened'
  | 'pull_request.ready_for_review';

export async function handlePullRequestEvent(
  app: Probot,
  context: Context<VerificationEvent>,
  alreadyLeased?: WebhookJobDecision,
): Promise<void> {
  const username = context.payload.pull_request.user.login;
  const accountId = String(context.payload.pull_request.user.id);
  const sha = context.payload.pull_request.head.sha;
  const prNumber = context.payload.pull_request.number;
  const installationId = String(context.payload.installation?.id ?? '');
  const repoInfo = context.repo();

  const decision = alreadyLeased ?? (await beginJob(app, context));
  if (decision?.disposition === 'skip') return;
  if (decision?.checkRunId) {
    await resumeCheck(app, context, decision.checkRunId);
    return;
  }

  app.log.info(
    `deliveryId=${context.id ?? ''} owner=${repoInfo.owner} repo=${repoInfo.repo} prNumber=${prNumber} sha=${sha} action=${context.payload.action}`,
  );

  const existingRuns = await context.octokit.checks.listForRef({
    ...repoInfo,
    ref: sha,
    check_name: CHECK_NAME,
    filter: 'latest',
  });

  const alreadyProcessed = existingRuns.data.check_runs.some((run) => {
    if (run.name !== CHECK_NAME || run.head_sha !== sha || run.status === 'queued') return false;
    if (context.payload.action === 'ready_for_review' && run.output?.title === 'Draft pull request') return false;
    if (context.payload.action === 'reopened') return false;
    return true;
  });

  if (alreadyProcessed) {
    app.log.info(`Idempotency: check run for SHA ${sha.slice(0, 7)} already exists — skipping re-delivery.`);
    const existing = existingRuns.data.check_runs.find((run) => {
      if (run.name !== CHECK_NAME || run.head_sha !== sha || run.status === 'queued') return false;
      if (context.payload.action === 'ready_for_review' && run.output?.title === 'Draft pull request') return false;
      return true;
    });
    if (context.id && existing) {
      await rememberCheck(app, context.id, String(existing.id));
      const title = existing.output?.title;
      if (title === 'Draft pull request' || title === 'Contributor verification unavailable') {
        await completeJob(app, context.id);
      } else {
        await resumeCheck(app, context, String(existing.id));
      }
    }
    return;
  }

  if (context.payload.pull_request.draft === true) {
    const { data: draftRun } = await context.octokit.checks.create({
      ...repoInfo,
      name: CHECK_NAME,
      head_sha: sha,
      status: 'completed',
      conclusion: 'neutral',
      output: {
        title: 'Draft pull request',
        summary: 'Verification runs when this pull request is marked ready.',
      },
    });
    await rememberCheck(app, context.id, String(draftRun.id));
    await completeJob(app, context.id);
    return;
  }

  const policyYaml = await readDefaultBranchPolicy(app, context);

  let session: PresentationSessionResult;
  try {
    session = await openPresentationSession({
      githubAccountId: accountId,
      githubUsername: username,
      installationId,
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      prNumber,
      headSha: sha,
      policyYaml,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.error(`Heka API call failed for @${username}: ${message}`);
    const { data: failedRun } = await context.octokit.checks.create({
      ...repoInfo,
      name: CHECK_NAME,
      head_sha: sha,
      status: 'completed',
      conclusion: 'failure',
      output: {
        title: 'Contributor verification unavailable',
        summary:
          `The Heka identity service did not open a verification session for **@${username}**.\n\n` +
          `Push another commit to this pull request to try again.`,
      },
    });
    await rememberCheck(app, context.id, String(failedRun.id));
    await completeJob(app, context.id);
    return;
  }

  const posted = postedCheck(session, username);
  const fromFork = isFork(context);
  const summary =
    fromFork && posted.conclusion === 'action_required'
      ? `${posted.summary}\n\nThis pull request comes from a fork. The author is @${username}.`
      : posted.summary;
  const { data: checkRun } = await context.octokit.checks.create({
    ...repoInfo,
    name: CHECK_NAME,
    head_sha: sha,
    status: 'completed',
    conclusion: posted.conclusion,
    details_url: session.sessionUrl,
    output: {
      title: posted.title,
      summary,
    },
  });
  await rememberCheck(app, context.id, String(checkRun.id));

  try {
    await attachPresentationCheckRun(session.sessionId, String(checkRun.id));
    await completeJob(app, context.id);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.error(`Could not store check run ${checkRun.id} on session ${session.sessionId}: ${message}`);
    if (posted.conclusion !== 'action_required') return;
    await context.octokit.checks.update({
      ...repoInfo,
      check_run_id: checkRun.id,
      status: 'completed',
      conclusion: 'failure',
      output: {
        title: 'Contributor verification could not be linked',
        summary:
          `A verification session was opened for **@${username}**, but this check could not be attached to it.\n\n` +
          `Push another commit to this pull request to try again.`,
      },
    });
  }
}

/** Closes open Heka sessions. A closed pull request does not get a new check run. */
export async function handlePullRequestClosed(
  app: Probot,
  context: Context<'pull_request.closed'>,
  alreadyLeased?: WebhookJobDecision,
): Promise<void> {
  const sha = context.payload.pull_request.head.sha;
  const prNumber = context.payload.pull_request.number;
  const repoInfo = context.repo();
  const decision = alreadyLeased ?? (await beginJob(app, context));
  if (decision?.disposition === 'skip') return;

  app.log.info(
    `deliveryId=${context.id ?? ''} owner=${repoInfo.owner} repo=${repoInfo.repo} prNumber=${prNumber} sha=${sha} action=${context.payload.action}`,
  );

  try {
    await closePresentationSessions({ owner: repoInfo.owner, repo: repoInfo.repo, prNumber });
    await completeJob(app, context.id);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.error(
      `deliveryId=${context.id ?? ''} owner=${repoInfo.owner} repo=${repoInfo.repo} prNumber=${prNumber} sha=${sha} action=closed ${message}`,
    );
  }
}

/** Replays jobs whose worker stopped after GitHub had already accepted the webhook. */
export async function resumeAbandonedPullRequests(app: Probot, now = Date.now()): Promise<void> {
  const abandoned = await webhookJobs().leaseAbandoned(now);
  for (const job of abandoned) {
    try {
      const context = await contextForAbandonedJob(app, job);
      const held: WebhookJobDecision = {
        disposition: 'run',
        status: 'processing',
        checkRunId: job.checkRunId,
      };
      if (job.event.action === 'closed') {
        await handlePullRequestClosed(app, context as Context<'pull_request.closed'>, held);
        continue;
      }
      await handlePullRequestEvent(app, context as Context<VerificationEvent>, held);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      app.log.error(`deliveryId=${job.deliveryId} resume failed. ${message}`);
    }
  }
}

/**
 * Reads `.heka/config.yml` from the repository default branch only.
 * A missing file or any contents error omits the document so the identity
 * service falls back to warn mode. The file is never logged.
 */
function isFork(context: Context<VerificationEvent>): boolean {
  const headRepo = context.payload.pull_request.head.repo;
  if (headRepo === undefined) return false;
  if (headRepo === null) return true;
  return headRepo.full_name !== context.payload.repository.full_name;
}

async function readDefaultBranchPolicy(
  app: Probot,
  context: Context<VerificationEvent>,
): Promise<string | undefined> {
  const defaultBranch = context.payload.repository.default_branch;
  if (!defaultBranch) {
    app.log.warn(`No default branch on ${context.payload.repository.full_name}; opening the session without a policy file.`);
    return undefined;
  }

  try {
    const { data } = await context.octokit.repos.getContent({
      ...context.repo(),
      path: '.heka/config.yml',
      ref: defaultBranch,
    });
    if (Array.isArray(data) || !('content' in data) || typeof data.content !== 'string') {
      app.log.warn(`.heka/config.yml on ${defaultBranch} is not a file; opening the session without a policy file.`);
      return undefined;
    }
    const decoded = Buffer.from(data.content, 'base64').toString('utf8');
    return decoded.trim() === '' ? undefined : decoded;
  } catch (error: unknown) {
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    if (status !== 404) {
      const message = error instanceof Error ? error.message : String(error);
      app.log.warn(`Could not read .heka/config.yml from ${defaultBranch}: ${message}`);
    }
    return undefined;
  }
}

function normalizePullRequest(
  context: Context<VerificationEvent | 'pull_request.closed'>,
): NormalizedPullRequestEvent | undefined {
  if (!context.id) return undefined;
  const action = context.payload.action;
  if (
    action !== 'opened' &&
    action !== 'synchronize' &&
    action !== 'reopened' &&
    action !== 'ready_for_review' &&
    action !== 'closed'
  ) {
    return undefined;
  }
  const pullRequest = context.payload.pull_request;
  const repoInfo = context.repo();
  const headRepo = pullRequest.head.repo;
  const fork =
    headRepo === undefined
      ? false
      : headRepo === null
        ? true
        : headRepo.full_name !== context.payload.repository.full_name;
  return {
    deliveryId: context.id,
    action,
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    prNumber: pullRequest.number,
    headSha: pullRequest.head.sha,
    githubAccountId: String(pullRequest.user.id),
    githubUsername: pullRequest.user.login,
    installationId: String(context.payload.installation?.id ?? ''),
    draft: pullRequest.draft === true,
    fork,
    defaultBranch: context.payload.repository.default_branch ?? undefined,
  };
}

async function beginJob(
  app: Probot,
  context: Context<VerificationEvent | 'pull_request.closed'>,
): Promise<WebhookJobDecision | undefined> {
  const event = normalizePullRequest(context);
  if (!event) return undefined;
  try {
    const decision = await webhookJobs().accept(event, Date.now());
    if (decision.disposition === 'skip') {
      app.log.info(`deliveryId=${event.deliveryId} status=${decision.status} already leased or finished`);
    }
    return decision;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.warn(`Could not record delivery ${event.deliveryId}. Falling back to this process only. ${message}`);
    if (alreadyDelivered(event.deliveryId)) return { disposition: 'skip', status: 'processing' };
    return { disposition: 'run', status: 'processing' };
  }
}

async function rememberCheck(app: Probot, deliveryId: string | undefined, checkRunId: string): Promise<void> {
  if (!deliveryId) return;
  try {
    await webhookJobs().recordCheck(deliveryId, checkRunId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.warn(`Could not store check run ${checkRunId} for delivery ${deliveryId}. ${message}`);
  }
}

async function completeJob(app: Probot, deliveryId: string | undefined): Promise<void> {
  if (!deliveryId) return;
  try {
    await webhookJobs().finish(deliveryId, 'completed');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.warn(`Could not finish delivery ${deliveryId}. ${message}`);
  }
}

/**
 * The check run already exists. Attach it and only then mark the job completed.
 * `settleWebhookJob` does not create a second check when `checkRunId` is set.
 */
async function resumeCheck(app: Probot, context: Context<VerificationEvent>, checkRunId: string): Promise<void> {
  const event = normalizePullRequest(context);
  if (!event) return;
  const job: WebhookJobRecord = {
    deliveryId: event.deliveryId,
    event,
    status: 'processing',
    checkRunId,
    leaseUntil: Date.now(),
  };
  await settleWebhookJob(job, webhookJobs(), {
    ensureCheck: async (existing) => existing ?? checkRunId,
    attach: (id) => attachExistingCheck(app, context, id),
  });
}

async function attachExistingCheck(
  app: Probot,
  context: Context<VerificationEvent>,
  checkRunId: string,
): Promise<void> {
  const pullRequest = context.payload.pull_request;
  const repoInfo = context.repo();
  const policyYaml = await readDefaultBranchPolicy(app, context);
  const session = await openPresentationSession({
    githubAccountId: String(pullRequest.user.id),
    githubUsername: pullRequest.user.login,
    installationId: String(context.payload.installation?.id ?? ''),
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    prNumber: pullRequest.number,
    headSha: pullRequest.head.sha,
    policyYaml,
  });
  await attachPresentationCheckRun(session.sessionId, checkRunId);
}

async function contextForAbandonedJob(app: Probot, job: WebhookJobRecord): Promise<Context<VerificationEvent>> {
  const installationId = Number(job.event.installationId);
  const octokit = await app.auth(Number.isFinite(installationId) ? installationId : undefined);
  const fullName = `${job.event.owner}/${job.event.repo}`;
  return {
    id: job.deliveryId,
    name: 'pull_request',
    payload: {
      action: job.event.action,
      installation: { id: installationId },
      repository: {
        name: job.event.repo,
        full_name: fullName,
        default_branch: job.event.defaultBranch ?? 'main',
        owner: { login: job.event.owner },
      },
      pull_request: {
        number: job.event.prNumber,
        draft: job.event.draft,
        user: { login: job.event.githubUsername, id: Number(job.event.githubAccountId) },
        head: {
          sha: job.event.headSha,
          repo: job.event.fork ? null : { full_name: fullName },
        },
      },
    },
    octokit,
    repo: () => ({ owner: job.event.owner, repo: job.event.repo }),
    log: app.log,
  } as unknown as Context<VerificationEvent>;
}

function postedCheck(
  session: PresentationSessionResult,
  username: string,
): { conclusion: 'neutral' | 'success' | 'action_required'; title: string; summary: string } {
  const invalidPolicy =
    session.configWarning === 'repository_config_invalid'
      ? '\n\nThe repository policy file is invalid. Verification is using warn mode until .heka/config.yml is fixed.'
      : '';
  if (session.disposition === 'skip') {
    return {
      conclusion: 'neutral',
      title: 'Contributor verification disabled',
      summary: `${session.humanReason ?? 'Verification is disabled for this repository.'}${invalidPolicy}`,
    };
  }
  if (session.disposition === 'grace' || session.alreadySatisfied) {
    return {
      conclusion: 'success',
      title: 'Contributor identity verified',
      summary: `${
        session.humanReason ??
        `**@${username}** already presented a contributor credential within the last 15 minutes.`
      }${invalidPolicy}`,
    };
  }
  return {
    conclusion: 'action_required',
    title: 'Contributor verification required',
    summary:
      `**@${username}** needs to present their Heka contributor credential.\n\n` +
      `Open the details page. The Heka wallet presents the credential, and this check updates when verification finishes.` +
      invalidPolicy,
  };
}

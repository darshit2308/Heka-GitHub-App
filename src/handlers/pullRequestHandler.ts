import { Context, Probot } from 'probot';
import { alreadyDelivered } from './delivery-memory.js';
import {
  attachPresentationCheckRun,
  claimWebhookDelivery,
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
 *   1. Skip the delivery when this commit already has a Heka check run.
 *   2. Ask the identity service for an OID4VP session. The session page is
 *      the check's `details_url`.
 *   3. Create the check as Action Required, or as success when a presentation
 *      from this GitHub account already succeeded inside the last 15 minutes.
 *   4. Store the check run id on the session. The identity service updates
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
): Promise<void> {
  const username = context.payload.pull_request.user.login;
  const accountId = String(context.payload.pull_request.user.id);
  const sha = context.payload.pull_request.head.sha;
  const prNumber = context.payload.pull_request.number;
  const installationId = String(context.payload.installation?.id ?? '');
  const repoInfo = context.repo();

  if (await deliveryAlreadyHandled(app, context.id)) return;

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
    return;
  }

  if (context.payload.pull_request.draft === true) {
    await context.octokit.checks.create({
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
    await context.octokit.checks.create({
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

  try {
    await attachPresentationCheckRun(session.sessionId, String(checkRun.id));
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
): Promise<void> {
  const sha = context.payload.pull_request.head.sha;
  const prNumber = context.payload.pull_request.number;
  const repoInfo = context.repo();
  if (await deliveryAlreadyHandled(app, context.id)) return;

  app.log.info(
    `deliveryId=${context.id ?? ''} owner=${repoInfo.owner} repo=${repoInfo.repo} prNumber=${prNumber} sha=${sha} action=${context.payload.action}`,
  );

  try {
    await closePresentationSessions({ owner: repoInfo.owner, repo: repoInfo.repo, prNumber });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.error(
      `deliveryId=${context.id ?? ''} owner=${repoInfo.owner} repo=${repoInfo.repo} prNumber=${prNumber} sha=${sha} action=closed ${message}`,
    );
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

async function deliveryAlreadyHandled(app: Probot, deliveryId: string | undefined): Promise<boolean> {
  if (!deliveryId) return false;
  try {
    const claimed = await claimWebhookDelivery(deliveryId);
    return !claimed;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.warn(`Could not record delivery ${deliveryId}. Falling back to this process only. ${message}`);
    return alreadyDelivered(deliveryId);
  }
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

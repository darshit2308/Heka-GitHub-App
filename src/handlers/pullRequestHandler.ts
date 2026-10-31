import { Context, Probot } from 'probot';
import {
  attachPresentationCheckRun,
  openPresentationSession,
  type PresentationSessionResult,
} from '../services/hekaService.ts';

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
export async function handlePullRequestEvent(
  app: Probot,
  context: Context<'pull_request.opened' | 'pull_request.synchronize' | 'pull_request.reopened'>,
): Promise<void> {
  const username = context.payload.pull_request.user.login;
  const accountId = String(context.payload.pull_request.user.id);
  const sha = context.payload.pull_request.head.sha;
  const prNumber = context.payload.pull_request.number;
  const installationId = String(context.payload.installation?.id ?? '');
  const repoInfo = context.repo();

  app.log.info(`PR #${prNumber} from @${username} (SHA: ${sha.slice(0, 7)}) — opening identity verification.`);

  const existingRuns = await context.octokit.checks.listForRef({
    ...repoInfo,
    ref: sha,
    check_name: CHECK_NAME,
    filter: 'latest',
  });

  const alreadyProcessed = existingRuns.data.check_runs.some(
    (run) => run.name === CHECK_NAME && run.head_sha === sha && run.status !== 'queued',
  );

  if (alreadyProcessed) {
    app.log.info(`Idempotency: check run for SHA ${sha.slice(0, 7)} already exists — skipping re-delivery.`);
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
  const { data: checkRun } = await context.octokit.checks.create({
    ...repoInfo,
    name: CHECK_NAME,
    head_sha: sha,
    status: 'completed',
    conclusion: posted.conclusion,
    details_url: session.sessionUrl,
    output: {
      title: posted.title,
      summary: posted.summary,
    },
  });

  try {
    await attachPresentationCheckRun(session.sessionId, String(checkRun.id));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.error(`Could not store check run ${checkRun.id} on session ${session.sessionId}: ${message}`);
  }
}

/**
 * Reads `.heka/config.yml` from the repository default branch only.
 * A missing file or any contents error omits the document so the identity
 * service falls back to warn mode. The file is never logged.
 */
async function readDefaultBranchPolicy(
  app: Probot,
  context: Context<'pull_request.opened' | 'pull_request.synchronize' | 'pull_request.reopened'>,
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

function postedCheck(
  session: PresentationSessionResult,
  username: string,
): { conclusion: 'neutral' | 'success' | 'action_required'; title: string; summary: string } {
  if (session.disposition === 'skip') {
    return {
      conclusion: 'neutral',
      title: 'Contributor verification disabled',
      summary: session.humanReason ?? 'Verification is disabled for this repository.',
    };
  }
  if (session.disposition === 'grace' || session.alreadySatisfied) {
    return {
      conclusion: 'success',
      title: 'Contributor identity verified',
      summary:
        session.humanReason ??
        `**@${username}** already presented a contributor credential within the last 15 minutes.`,
    };
  }
  return {
    conclusion: 'action_required',
    title: 'Contributor verification required',
    summary:
      `**@${username}** needs to present their Heka contributor credential.\n\n` +
      `Open the details page. The Heka wallet presents the credential, and this check updates when verification finishes.`,
  };
}

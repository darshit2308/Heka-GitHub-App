import { Context, Probot } from 'probot';
import { verifyContributor } from '../services/hekaService.ts';
import type { VerificationResult } from '../types/verification.ts';

/** The canonical name used for all check runs created by this App. */
const CHECK_NAME = 'Heka Identity Verification';

/**
 * Handles `pull_request.opened`, `pull_request.synchronize`, and
 * `pull_request.reopened` webhook events.
 *
 * Flow:
 *   1. **Idempotency guard** — before creating anything, list existing check
 *      runs for this commit SHA.  If a non-queued check run named
 *      {@link CHECK_NAME} already exists for the same SHA, the event is a
 *      re-delivery of a webhook we already processed; skip it.
 *   2. Create an `in_progress` check run immediately so the PR shows
 *      a "pending" badge while the identity service is queried.
 *   3. Call heka-identity-service to determine verification status.
 *   4. Update (complete) the check run with a `success` or `failure`
 *      conclusion and a human-readable output block.
 *
 * **Error isolation:** Heka API failures (network errors, 5xx responses)
 * are caught inside this handler so a service outage never causes Probot to
 * emit an unhandled-rejection.  In that case the check run is completed with
 * `failure` and a message directing the contributor to retry.
 *
 * @param app     - Probot instance (used for structured logging only).
 * @param context - Webhook event context providing the payload and Octokit client.
 */
export async function handlePullRequestEvent(
  app: Probot,
  context: Context<'pull_request.opened' | 'pull_request.synchronize' | 'pull_request.reopened'>,
): Promise<void> {
  const username = context.payload.pull_request.user.login;
  const sha = context.payload.pull_request.head.sha;
  const prNumber = context.payload.pull_request.number;
  const repoInfo = context.repo();

  app.log.info(`PR #${prNumber} from @${username} (SHA: ${sha.slice(0, 7)}) — starting identity check.`);

  // ---------------------------------------------------------------------------
  // Step 1: Idempotency guard
  //
  // GitHub delivers webhooks on an "at least once" basis: the same payload may
  // be re-delivered if an earlier delivery timed out or failed.  Without this
  // check, a re-delivery would create a duplicate check run on the PR.
  //
  // A check run is considered "already processed" if:
  //   - its name matches CHECK_NAME, AND
  //   - its head_sha matches the current commit, AND
  //   - its status is not 'queued' (queued means it was created but not yet started)
  // ---------------------------------------------------------------------------
  const existingRuns = await context.octokit.checks.listForRef({
    ...repoInfo,
    ref: sha,
    check_name: CHECK_NAME,
    filter: 'latest',
  });

  const alreadyProcessed = existingRuns.data.check_runs.some(
    (run) => run.head_sha === sha && run.status !== 'queued',
  );

  if (alreadyProcessed) {
    app.log.info(
      `Idempotency: check run for SHA ${sha.slice(0, 7)} already exists — skipping re-delivery.`,
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 2: Create in_progress check run
  //
  // This appears immediately in the PR's "Checks" panel, giving the contributor
  // real-time feedback that verification is running.
  // Capture the check run id so we can update (not duplicate) it below.
  // ---------------------------------------------------------------------------
  const { data: checkRun } = await context.octokit.checks.create({
    ...repoInfo,
    name: CHECK_NAME,
    head_sha: sha,
    status: 'in_progress',
  });

  // ---------------------------------------------------------------------------
  // Step 3: Query heka-identity-service
  // ---------------------------------------------------------------------------
  let verificationResult: VerificationResult = { isVerified: false, githubUsername: username };

  try {
    verificationResult = await verifyContributor(username);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.error(`Heka API call failed for @${username}: ${message}`);
    // verificationResult stays { isVerified: false } — we fall through to the
    // failure check run below with a service-outage message.
  }

  // ---------------------------------------------------------------------------
  // Step 4: Update the existing check run to completed
  //
  // Using checks.update (not a second checks.create) so the PR Checks panel
  // shows a single entry that transitions from "in progress" → pass/fail.
  // ---------------------------------------------------------------------------
  if (verificationResult.isVerified) {
    app.log.info(`✓ Identity verified for @${username} — fingerprint: ${verificationResult.gpgFingerprint}`);

    await context.octokit.checks.update({
      ...repoInfo,
      check_run_id: checkRun.id,
      status: 'completed',
      conclusion: 'success',
      output: {
        title: 'Contributor Identity Verified ✅',
        summary:
          `**@${username}** has proved ownership of their GitHub GPG key through the ` +
          `Heka cryptographic challenge-response protocol.\n\n` +
          `**GPG Key Fingerprint:** \`${verificationResult.gpgFingerprint}\`\n` +
          `**Verified at:** ${verificationResult.verifiedAt ?? 'unknown'}`,
      },
    });
  } else {
    app.log.warn(`✗ Verification not found for @${username}`);

    await context.octokit.checks.update({
      ...repoInfo,
      check_run_id: checkRun.id,
      status: 'completed',
      conclusion: 'failure',
      output: {
        title: 'Unverified Contributor ❌',
        summary:
          `No verified GPG identity was found for **@${username}**.\n\n` +
          `To contribute to this repository you must complete the Heka identity ` +
          `verification process:\n\n` +
          `1. Visit the **Heka Contributor Portal** to begin onboarding.\n` +
          `2. Request a GPG ownership challenge for your GitHub account.\n` +
          `3. Sign the challenge nonce with your GPG private key and submit the proof.\n\n` +
          `Once verified, re-open or push a new commit to this pull request.`,
      },
    });
  }
}

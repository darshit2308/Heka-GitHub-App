import path from 'path';
import { fileURLToPath } from 'url';

import { Probot } from 'probot';
import {
  handlePullRequestClosed,
  handlePullRequestEvent,
  resumeAbandonedPullRequests,
} from './handlers/pullRequestHandler.js';
import { installProductionWebhookJobStore } from './handlers/webhook-job-store.js';

/**
 * Probot reads PRIVATE_KEY from the environment. A path inside this
 * repository is refused so a committed key cannot stay in use.
 */
function assertRuntimeKeyIsOutsideTheRepo(): void {
  const configured = process.env.PRIVATE_KEY_PATH;
  if (!configured) return;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const relative = path.relative(repoRoot, path.resolve(configured));
  const inside = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  if (inside) {
    throw new Error(
      'PRIVATE_KEY_PATH points inside this repository. Set PRIVATE_KEY from an environment secret, and revoke any key that was committed.',
    );
  }
}

/**
 * Heka GitHub App entry point.
 *
 * Wires Probot event listeners to the handlers that implement the
 * contributor identity verification flow.
 *
 * Probot guarantees:
 *   - Webhook HMAC-SHA256 signature validation before any listener fires
 *   - HTTP 200 returned to GitHub immediately on receipt (before async
 *     listeners complete), satisfying the 10-second delivery timeout
 *   - Automatic GitHub App JWT and installation access-token management
 *
 * @param app - Probot application instance.
 */
export default (app: Probot): void => {
  assertRuntimeKeyIsOutsideTheRepo();
  if (process.env.NODE_ENV !== 'test') {
    installProductionWebhookJobStore();
    void resumeAbandonedPullRequests(app).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      app.log.error(`Could not resume webhook jobs. ${message}`);
    });
  }
  app.log.info('Heka identity verification bot is live and listening.');

  // Trigger on all PR lifecycle events that can introduce new commits.
  // - opened:           first PR creation
  // - synchronize:      new push to an existing PR branch
  // - reopened:         PR re-opened after being closed without merge
  // - ready_for_review: a draft was marked ready and should be verified
  app.on(
    ['pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened', 'pull_request.ready_for_review'],
    async (context) => {
      await handlePullRequestEvent(app, context);
    },
  );

  app.on('pull_request.closed', async (context) => {
    await handlePullRequestClosed(app, context);
  });
};

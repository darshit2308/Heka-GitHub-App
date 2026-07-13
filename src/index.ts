import { Probot } from 'probot';
import { handlePullRequestEvent } from './handlers/pullRequestHandler.ts';

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
  app.log.info('Heka identity verification bot is live and listening.');

  // Trigger on all PR lifecycle events that can introduce new commits.
  // - opened:      first PR creation
  // - synchronize: new push to an existing PR branch
  // - reopened:    PR re-opened after being closed without merge
  app.on(
    ['pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened'],
    async (context) => {
      await handlePullRequestEvent(app, context);
    },
  );
};

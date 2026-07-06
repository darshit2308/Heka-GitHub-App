import nock from 'nock';
import myProbotApp from '../src/index.js';
import { Probot, ProbotOctokit } from 'probot';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, beforeEach, afterEach, test, expect } from 'vitest';

import { HEKA_GPG_PATH } from '../src/config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const privateKey = fs.readFileSync(
  path.join(__dirname, 'fixtures/mock-cert.pem'),
  'utf-8',
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const openedPayload = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/pull_request.opened.json'), 'utf-8'),
);

const synchronizePayload = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/pull_request.synchronize.json'), 'utf-8'),
);

// A reopened payload is identical in structure to opened — reuse and override action.
const reopenedPayload = { ...openedPayload, action: 'reopened' };

// ---------------------------------------------------------------------------
// Helper: shared GitHub API mocks that every test requires
// ---------------------------------------------------------------------------

/**
 * Mocks the two GitHub API calls that Probot makes before any handler runs:
 *   1. POST /app/installations/:id/access_tokens  — obtain installation token
 *   2. GET  /repos/:owner/:repo/commits/:sha/check-runs  — idempotency list
 *
 * @param sha   - The head commit SHA from the payload.
 * @param runs  - Array of existing check runs to return (empty = first delivery).
 */
function mockGitHubPreamble(sha: string, runs: object[] = []) {
  return nock('https://api.github.com')
    .post('/app/installations/2/access_tokens')
    .reply(200, { token: 'test', permissions: { checks: 'write' } })
    .get(`/repos/test-org/test-repo/commits/${sha}/check-runs`)
    .query({ check_name: 'Heka Identity Verification', filter: 'latest' })
    .reply(200, { total_count: runs.length, check_runs: runs });
}

/**
 * Mocks the heka-identity-service status endpoint.
 *
 * @param username - GitHub login to mock.
 * @param result   - The verification result to return.
 */
function mockHekaStatus(
  username: string,
  result: { isVerified: boolean; githubUsername: string; gpgFingerprint?: string; verifiedAt?: string },
) {
  return nock(HEKA_GPG_PATH)
    .get(`/status/${username}`)
    .reply(200, result);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Heka Identity Verification Bot', () => {
  let probot: Probot;

  beforeEach(() => {
    nock.disableNetConnect();
    probot = new Probot({
      appId: 123,
      privateKey,
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });
    probot.load(myProbotApp);
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  // -----------------------------------------------------------------------
  // Happy path — verified contributor
  // -----------------------------------------------------------------------

  test('creates a success check run when Heka returns a verified contributor', async () => {
    const sha = openedPayload.pull_request.head.sha;

    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.name).toBe('Heka Identity Verification');
        expect(body.head_sha).toBe(sha);
        expect(body.status).toBe('in_progress');
        return true;
      })
      .reply(201)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.status).toBe('completed');
        expect(body.conclusion).toBe('success');
        expect(body.output.title).toContain('Verified');
        expect(body.output.summary).toContain('A1B2C3D4');
        return true;
      })
      .reply(201);

    const hekaMock = mockHekaStatus('test-contributor', {
      isVerified: true,
      githubUsername: 'test-contributor',
      gpgFingerprint: 'A1B2C3D4E5F6',
      verifiedAt: '2026-07-06T09:00:00.000Z',
    });

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
    expect(hekaMock.pendingMocks()).toStrictEqual([]);
  });

  // -----------------------------------------------------------------------
  // Unverified contributor
  // -----------------------------------------------------------------------

  test('creates a failure check run when Heka returns an unverified contributor', async () => {
    const sha = openedPayload.pull_request.head.sha;

    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.status).toBe('in_progress');
        return true;
      })
      .reply(201)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.status).toBe('completed');
        expect(body.conclusion).toBe('failure');
        expect(body.output.title).toContain('Unverified');
        return true;
      })
      .reply(201);

    const hekaMock = mockHekaStatus('test-contributor', {
      isVerified: false,
      githubUsername: 'test-contributor',
    });

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
    expect(hekaMock.pendingMocks()).toStrictEqual([]);
  });

  // -----------------------------------------------------------------------
  // Heka API failure — service outage
  // -----------------------------------------------------------------------

  test('creates a failure check run when the Heka API is unreachable', async () => {
    const sha = openedPayload.pull_request.head.sha;

    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.status).toBe('in_progress');
        return true;
      })
      .reply(201)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.status).toBe('completed');
        expect(body.conclusion).toBe('failure');
        return true;
      })
      .reply(201);

    // Simulate a network-level failure from the identity service
    nock(HEKA_GPG_PATH).get('/status/test-contributor').replyWithError('ECONNREFUSED');

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  // -----------------------------------------------------------------------
  // pull_request.synchronize — new push to existing PR
  // -----------------------------------------------------------------------

  test('handles pull_request.synchronize and creates check run for the new SHA', async () => {
    const sha = synchronizePayload.pull_request.head.sha;

    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.head_sha).toBe(sha); // New SHA, not the opened event SHA
        expect(body.status).toBe('in_progress');
        return true;
      })
      .reply(201)
      .post('/repos/test-org/test-repo/check-runs')
      .reply(201);

    mockHekaStatus('test-contributor', {
      isVerified: false,
      githubUsername: 'test-contributor',
    });

    await probot.receive({ name: 'pull_request', payload: synchronizePayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  // -----------------------------------------------------------------------
  // pull_request.reopened
  // -----------------------------------------------------------------------

  test('handles pull_request.reopened and creates a check run', async () => {
    const sha = reopenedPayload.pull_request.head.sha;

    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.status).toBe('in_progress');
        return true;
      })
      .reply(201)
      .post('/repos/test-org/test-repo/check-runs')
      .reply(201);

    mockHekaStatus('test-contributor', {
      isVerified: false,
      githubUsername: 'test-contributor',
    });

    await probot.receive({ name: 'pull_request', payload: reopenedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  // -----------------------------------------------------------------------
  // Idempotency — duplicate webhook re-delivery
  // -----------------------------------------------------------------------

  test('skips processing when a non-queued check run already exists for the SHA', async () => {
    const sha = openedPayload.pull_request.head.sha;

    // Return an existing in_progress run for this SHA — simulates a re-delivery
    const githubMock = mockGitHubPreamble(sha, [
      {
        id: 1,
        name: 'Heka Identity Verification',
        head_sha: sha,
        status: 'in_progress',
        conclusion: null,
      },
    ]);

    // If idempotency fails, the handler would call checks.create and hekaService.
    // Neither mock is registered, so nock would throw if they are called.

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  // -----------------------------------------------------------------------
  // check run output contains GPG fingerprint on success
  // -----------------------------------------------------------------------

  test('success check run output summary contains the GPG fingerprint', async () => {
    const sha = openedPayload.pull_request.head.sha;
    const fingerprint = 'DEADBEEF12345678';

    mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs')
      .reply(201) // in_progress
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        const output = body.output as { summary: string };
        expect(output.summary).toContain(fingerprint);
        return true;
      })
      .reply(201);

    mockHekaStatus('test-contributor', {
      isVerified: true,
      githubUsername: 'test-contributor',
      gpgFingerprint: fingerprint,
      verifiedAt: '2026-07-06T09:00:00.000Z',
    });

    await probot.receive({ name: 'pull_request', payload: openedPayload });
  });
});

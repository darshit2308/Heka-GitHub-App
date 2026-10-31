import nock from 'nock';
import myProbotApp from '../src/index.js';
import { Probot, ProbotOctokit } from 'probot';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, beforeEach, afterEach, test, expect } from 'vitest';

import { HEKA_PRESENTATION_PATH, HEKA_URL } from '../src/config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const privateKey = fs.readFileSync(
  path.join(__dirname, 'fixtures/mock-cert.pem'),
  'utf-8',
);

const openedPayload = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/pull_request.opened.json'), 'utf-8'),
);

const synchronizePayload = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/pull_request.synchronize.json'), 'utf-8'),
);

const reopenedPayload = { ...openedPayload, action: 'reopened' };

const sessionUrl = 'http://localhost:8000/contributor/verify/sess-1';

function mockGitHubPreamble(
  sha: string,
  runs: object[] = [],
  policy: { yaml?: string; ref?: string; status?: number } = {},
) {
  const ref = policy.ref ?? 'main';
  const scope = nock('https://api.github.com')
    .post('/app/installations/2/access_tokens')
    .reply(200, { token: 'test', permissions: { checks: 'write', contents: 'read' } })
    .get(`/repos/test-org/test-repo/commits/${sha}/check-runs`)
    .query({ check_name: 'Heka Identity Verification', filter: 'latest' })
    .reply(200, { total_count: runs.length, check_runs: runs })
    .get('/repos/test-org/test-repo/contents/.heka%2Fconfig.yml')
    .query({ ref });

  if (policy.yaml === undefined) {
    return scope.reply(policy.status ?? 404, { message: 'Not Found' });
  }
  return scope.reply(200, {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(policy.yaml).toString('base64'),
  });
}

function mockOpenSession(
  result: {
    alreadySatisfied: boolean;
    humanReason?: string;
    disposition?: 'skip' | 'grace' | 'verify';
  },
  sha: string,
  policyYaml?: string,
) {
  return nock(HEKA_URL)
    .post('/v2/presentation-session', (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        githubAccountId: '12345',
        githubUsername: 'test-contributor',
        installationId: '2',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        headSha: sha,
      });
      if (policyYaml === undefined) {
        expect(body.policyYaml).toBeUndefined();
      } else {
        expect(body.policyYaml).toBe(policyYaml);
      }
      return true;
    })
    .matchHeader('authorization', 'Bearer test-status-token')
    .reply(201, {
      sessionId: 'sess-1',
      state: result.alreadySatisfied || result.disposition === 'skip' || result.disposition === 'grace'
        ? 'success'
        : 'pending',
      sessionUrl,
      alreadySatisfied: result.alreadySatisfied,
      humanReason: result.humanReason,
      disposition: result.disposition ?? 'verify',
    });
}

function mockAttachCheckRun() {
  return nock(HEKA_PRESENTATION_PATH)
    .patch('/sess-1/check-run', (body: Record<string, unknown>) => {
      expect(body.checkRunId).toBe('42');
      return true;
    })
    .reply(200, {});
}

describe('Heka Identity Verification Bot', () => {
  let probot: Probot;

  beforeEach(() => {
    process.env.HEKA_STATUS_TOKEN = 'test-status-token';
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
    delete process.env.HEKA_STATUS_TOKEN;
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test('creates an action-required check whose details page is the verification session', async () => {
    const sha = openedPayload.pull_request.head.sha;

    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.status).toBe('completed');
        expect(body.conclusion).toBe('action_required');
        expect(body.details_url).toBe(sessionUrl);
        expect(body.head_sha).toBe(sha);
        return true;
      })
      .reply(201, { id: 42, name: 'Heka Identity Verification', status: 'completed' });

    const hekaMock = mockOpenSession({ alreadySatisfied: false }, sha);
    const attachMock = mockAttachCheckRun();

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
    expect(hekaMock.pendingMocks()).toStrictEqual([]);
    expect(attachMock.pendingMocks()).toStrictEqual([]);
  });

  test('completes the check as success when a recent presentation already covers this account', async () => {
    const sha = openedPayload.pull_request.head.sha;

    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.conclusion).toBe('success');
        expect(body.details_url).toBe(sessionUrl);
        expect((body.output as { summary: string }).summary).toContain('already presented');
        return true;
      })
      .reply(201, { id: 42, name: 'Heka Identity Verification', status: 'completed' });

    mockOpenSession({ alreadySatisfied: true, humanReason: 'This account already presented.' }, sha);
    mockAttachCheckRun();

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  test('creates a failure check run when the Heka API is unreachable', async () => {
    const sha = openedPayload.pull_request.head.sha;

    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.status).toBe('completed');
        expect(body.conclusion).toBe('failure');
        expect(body.details_url).toBeUndefined();
        return true;
      })
      .reply(201, { id: 42, name: 'Heka Identity Verification', status: 'completed' });

    nock(HEKA_URL).post('/v2/presentation-session').replyWithError('ECONNREFUSED');

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  test('handles pull_request.synchronize and creates a check run for the new SHA', async () => {
    const sha = synchronizePayload.pull_request.head.sha;

    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.head_sha).toBe(sha);
        expect(body.conclusion).toBe('action_required');
        return true;
      })
      .reply(201, { id: 42, name: 'Heka Identity Verification', status: 'completed' });

    mockOpenSession({ alreadySatisfied: false }, sha);
    mockAttachCheckRun();

    await probot.receive({ name: 'pull_request', payload: synchronizePayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  test('handles pull_request.reopened and creates a check run', async () => {
    const sha = reopenedPayload.pull_request.head.sha;

    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs')
      .reply(201, { id: 42, name: 'Heka Identity Verification', status: 'completed' });

    mockOpenSession({ alreadySatisfied: false }, sha);
    mockAttachCheckRun();

    await probot.receive({ name: 'pull_request', payload: reopenedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  test('skips processing when a non-queued check run already exists for the SHA', async () => {
    const sha = openedPayload.pull_request.head.sha;

    const githubMock = nock('https://api.github.com')
      .post('/app/installations/2/access_tokens')
      .reply(200, { token: 'test', permissions: { checks: 'write' } })
      .get(`/repos/test-org/test-repo/commits/${sha}/check-runs`)
      .query({ check_name: 'Heka Identity Verification', filter: 'latest' })
      .reply(200, {
        total_count: 1,
        check_runs: [
          {
            id: 1,
            name: 'Heka Identity Verification',
            head_sha: sha,
            status: 'completed',
            conclusion: 'action_required',
          },
        ],
      });

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  test('opens a session without policyYaml when the default branch has no config file', async () => {
    const sha = openedPayload.pull_request.head.sha;
    const githubMock = mockGitHubPreamble(sha, [], { status: 404 })
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.conclusion).toBe('action_required');
        return true;
      })
      .reply(201, { id: 42, name: 'Heka Identity Verification', status: 'completed' });

    const hekaMock = mockOpenSession({ alreadySatisfied: false }, sha);
    mockAttachCheckRun();

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
    expect(hekaMock.pendingMocks()).toStrictEqual([]);
  });

  test('sends the config file from the default branch and ignores the pull request head', async () => {
    const sha = openedPayload.pull_request.head.sha;
    const policyYaml = 'version: 1\ncontributor_identity:\n  mode: enforce\n';
    const payload = {
      ...openedPayload,
      pull_request: {
        ...openedPayload.pull_request,
        head: { ...openedPayload.pull_request.head, ref: 'feature/x' },
      },
      repository: { ...openedPayload.repository, default_branch: 'main' },
    };

    const githubMock = mockGitHubPreamble(sha, [], { yaml: policyYaml, ref: 'main' })
      .post('/repos/test-org/test-repo/check-runs')
      .reply(201, { id: 42, name: 'Heka Identity Verification', status: 'completed' });

    const hekaMock = mockOpenSession({ alreadySatisfied: false }, sha, policyYaml);
    mockAttachCheckRun();

    await probot.receive({ name: 'pull_request', payload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
    expect(hekaMock.pendingMocks()).toStrictEqual([]);
  });

  test('posts a neutral check when the repository disables verification', async () => {
    const sha = openedPayload.pull_request.head.sha;
    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.conclusion).toBe('neutral');
        expect((body.output as { summary: string }).summary).toBe('Verification is disabled for this repository.');
        return true;
      })
      .reply(201, { id: 42, name: 'Heka Identity Verification', status: 'completed' });

    mockOpenSession(
      {
        alreadySatisfied: false,
        disposition: 'skip',
        humanReason: 'Verification is disabled for this repository.',
      },
      sha,
    );
    const attachMock = mockAttachCheckRun();

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
    expect(attachMock.pendingMocks()).toStrictEqual([]);
  });

  test('posts a success check during the onboarding grace window', async () => {
    const sha = openedPayload.pull_request.head.sha;
    const githubMock = mockGitHubPreamble(sha)
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.conclusion).toBe('success');
        expect((body.output as { summary: string }).summary).toContain('grace');
        return true;
      })
      .reply(201, { id: 42, name: 'Heka Identity Verification', status: 'completed' });

    mockOpenSession(
      { alreadySatisfied: false, disposition: 'grace', humanReason: 'Onboarding grace is active until later.' },
      sha,
    );
    mockAttachCheckRun();

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
  });

  test('still opens a session when the contents API fails for a reason other than a missing file', async () => {
    const sha = openedPayload.pull_request.head.sha;
    const githubMock = mockGitHubPreamble(sha, [], { status: 500 })
      .post('/repos/test-org/test-repo/check-runs', (body: Record<string, unknown>) => {
        expect(body.conclusion).toBe('action_required');
        return true;
      })
      .reply(201, { id: 42, name: 'Heka Identity Verification', status: 'completed' });

    const hekaMock = mockOpenSession({ alreadySatisfied: false }, sha);
    mockAttachCheckRun();

    await probot.receive({ name: 'pull_request', payload: openedPayload });

    expect(githubMock.pendingMocks()).toStrictEqual([]);
    expect(hekaMock.pendingMocks()).toStrictEqual([]);
  });
});

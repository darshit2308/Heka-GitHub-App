import axios from 'axios';
import { HEKA_GPG_PATH, HEKA_PRESENTATION_PATH } from '../config/env.ts';
import type { VerificationResult } from '../types/verification.ts';

export interface PresentationSessionRequest {
  githubAccountId: string;
  githubUsername: string;
  installationId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  policyYaml?: string;
}

export interface PresentationSessionResult {
  sessionId: string;
  state: string;
  sessionUrl: string;
  alreadySatisfied: boolean;
  humanReason?: string;
  disposition?: 'skip' | 'grace' | 'verify';
}

function statusToken(): string {
  const token = process.env.HEKA_STATUS_TOKEN;
  if (!token) {
    throw new Error('HEKA_STATUS_TOKEN is not set');
  }
  return token;
}

/**
 * Queries the Heka identity service to determine whether a contributor has
 * already completed GPG ownership verification.
 *
 * During a PR event the GitHub App's job is *not* to initiate a new challenge
 * — it is to check whether the PR author has already proved ownership of the
 * GPG key registered on their GitHub profile.  If they have not, the App
 * posts a failing check run with instructions directing them to the Heka web
 * portal to complete the flow.
 *
 * The status endpoint always returns HTTP 200 with `isVerified: false` for
 * contributors who have not yet verified, so this function never throws on a
 * "not found" case — only on genuine network or server errors.
 *
 * @param githubUsername - GitHub login of the PR author.
 * @returns A {@link VerificationResult} describing the contributor's status.
 * @throws If heka-identity-service is unreachable or returns a 5xx error.
 */
export async function verifyContributor(githubUsername: string): Promise<VerificationResult> {
  const response = await axios.get<VerificationResult>(
    `${HEKA_GPG_PATH}/status/${encodeURIComponent(githubUsername)}`,
    {
      // Fail fast if the identity service is down rather than blocking
      // Probot's handler thread for the full default timeout.
      timeout: 5_000,
      headers: { Authorization: `Bearer ${statusToken()}` },
    },
  );

  return response.data;
}

/**
 * Opens the OID4VP session for this pull request. The returned page URL is the
 * GitHub check `details_url`. A recent successful presentation for the same
 * GitHub account comes back with `alreadySatisfied`.
 */
export async function openPresentationSession(
  request: PresentationSessionRequest,
): Promise<PresentationSessionResult> {
  const response = await axios.post<PresentationSessionResult>(HEKA_PRESENTATION_PATH, request, {
    timeout: 10_000,
    headers: { Authorization: `Bearer ${statusToken()}` },
  });
  return response.data;
}

/** Stores the check run id on the session so a later result can update that check. */
export async function attachPresentationCheckRun(sessionId: string, checkRunId: string): Promise<void> {
  await axios.patch(
    `${HEKA_PRESENTATION_PATH}/${encodeURIComponent(sessionId)}/check-run`,
    { checkRunId },
    {
      timeout: 5_000,
      headers: { Authorization: `Bearer ${statusToken()}` },
    },
  );
}

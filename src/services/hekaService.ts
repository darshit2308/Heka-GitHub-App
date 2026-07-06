import axios from 'axios';
import { HEKA_GPG_PATH } from '../config/env.ts';
import type { VerificationResult } from '../types/verification.ts';

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
    },
  );

  return response.data;
}

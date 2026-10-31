import axios, { isAxiosError } from 'axios';
import { HEKA_PRESENTATION_PATH } from '../config/env.js';

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
  configWarning?: string;
}

export interface ClosePresentationRequest {
  owner: string;
  repo: string;
  prNumber: number;
}

function statusToken(): string {
  const token = process.env.HEKA_STATUS_TOKEN;
  if (!token) {
    throw new Error('HEKA_STATUS_TOKEN is not set');
  }
  return token;
}

/**
 * Opens the OID4VP session for this pull request. The returned page URL is the
 * GitHub check `details_url`. A recent successful presentation for the same
 * GitHub account comes back with `alreadySatisfied`.
 */
export async function openPresentationSession(
  request: PresentationSessionRequest,
): Promise<PresentationSessionResult> {
  const response = await withNetworkRetry(() =>
    axios.post<PresentationSessionResult>(HEKA_PRESENTATION_PATH, request, {
      timeout: 10_000,
      headers: { Authorization: `Bearer ${statusToken()}` },
    }),
  );
  return response.data;
}

/** Claims a webhook delivery id. False means this delivery was already handled. */
export async function claimWebhookDelivery(deliveryId: string): Promise<boolean> {
  const response = await withNetworkRetry(() =>
    axios.post<{ claimed: boolean }>(
      `${HEKA_PRESENTATION_PATH}/deliveries`,
      { deliveryId },
      {
        timeout: 5_000,
        headers: { Authorization: `Bearer ${statusToken()}` },
      },
    ),
  );
  return response.data.claimed === true;
}

/** Stores the check run id on the session so a later result can update that check. */
export async function attachPresentationCheckRun(sessionId: string, checkRunId: string): Promise<void> {
  await withNetworkRetry(() =>
    axios.patch(
      `${HEKA_PRESENTATION_PATH}/${encodeURIComponent(sessionId)}/check-run`,
      { checkRunId },
      {
        timeout: 5_000,
        headers: { Authorization: `Bearer ${statusToken()}` },
      },
    ),
  );
}

/** Asks Heka to fail open sessions for a pull request that was closed. */
export async function closePresentationSessions(request: ClosePresentationRequest): Promise<void> {
  await withNetworkRetry(() =>
    axios.post(`${HEKA_PRESENTATION_PATH}/close`, request, {
      timeout: 10_000,
      headers: { Authorization: `Bearer ${statusToken()}` },
    }),
  );
}

async function withNetworkRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (!isNetworkFailure(error)) throw error;
    return operation();
  }
}

function isNetworkFailure(error: unknown): boolean {
  if (!isAxiosError(error) || error.response) return false;
  return error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || !error.response;
}

export const HEKA_URL = process.env.HEKA_SERVICE_URL ?? 'http://localhost:3000';

/**
 * Versioned GPG routes on heka-identity-service.
 * Status checks require HEKA_STATUS_TOKEN, read at request time.
 */
export const HEKA_GPG_PATH = `${HEKA_URL}/v2/gpg-challenge`;

/**
 * OID4VP session routes. The GitHub App opens a session, then stores the
 * check run id so the identity service can complete that same check.
 */
export const HEKA_PRESENTATION_PATH = `${HEKA_URL}/v2/presentation-session`;
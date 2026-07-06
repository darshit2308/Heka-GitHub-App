export const HEKA_URL = process.env.HEKA_SERVICE_URL ?? 'http://localhost:3000';

/**
 * The GPG challenge sub-path on heka-identity-service.
 * Used to construct status-check and verification URLs.
 */
export const HEKA_GPG_PATH = `${HEKA_URL}/gpg-challenge`;
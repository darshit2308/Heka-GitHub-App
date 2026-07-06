export interface VerificationResult {
  /** Whether the contributor has completed GPG ownership verification. */
  isVerified: boolean;
  /** GitHub login that was queried. */
  githubUsername: string;
  /**
   * Fingerprint of the GPG key used for verification.
   * Present only when `isVerified` is `true`.
   */
  gpgFingerprint?: string;
  /**
   * UTC timestamp of the most recent successful verification.
   * Present only when `isVerified` is `true`.
   */
  verifiedAt?: string;
}

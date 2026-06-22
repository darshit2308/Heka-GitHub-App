import axios from 'axios'
import { HEKA_URL } from '../config/env.ts'
import type { VerificationResult } from '../types/verification.ts'

export async function verifyContributor(github_username: string): Promise<VerificationResult> {
  // Now we connect with the Mock Heka Identity Server running on port 3000
  // Another feature, got the tip to add from AI: Added 5s timeout so a dead Heka service fails fast
  // instead of hanging the webhook for 30 seconds until GitHub times it out
  const response = await axios.post(
    `${HEKA_URL}/verify`,
    { github_username },
    { timeout: 5000 }
  )

  return response.data
}

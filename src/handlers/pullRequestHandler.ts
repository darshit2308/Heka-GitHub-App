import { Context, Probot } from 'probot'
import { verifyContributor } from '../services/hekaService.ts'
import type { VerificationResult } from '../types/verification.ts'

export async function handlePullRequestEvent(app: Probot, context: Context<'pull_request.opened' | 'pull_request.synchronize'>) {
  // Fetching the information from the GitHub webhook payload
  const username = context.payload.pull_request.user.login
  const sha = context.payload.pull_request.head.sha // commit hash
  const repoInfo = context.repo() // used to get the repo owner and name

  app.log.info(`\nSpotted a PR from @${username}. Starting verification...`)

  // As soon as the above step happens, we post an 'In Progress' status on the PR
  await context.octokit.checks.create({
    ...repoInfo,
    name: 'Heka Identity Verification',
    head_sha: sha,
    status: 'in_progress',
  })

  // storing the verification in a variable
  let verificationResult: VerificationResult = { isValid: false }

  try {
    // Store the result so we can use it outside this try block
    verificationResult = await verifyContributor(username)
  } catch (error: any) {
    // This catch ONLY handles Heka API failures (network error, timeout, 404, etc.)
    // It does not handle GitHub API errors
    app.log.error(`Heka API call failed for @${username}: ${error.message}`)
    // verificationResult stays { isValid: false } , as default value
  }

  // The Heka might respond with valid or invalid
  if (verificationResult.isValid) {
    app.log.info(`✅ Successfully verified @${username}`)

    // After the user is verified, update the PR panel in GitHub
    await context.octokit.checks.create({
      ...repoInfo,
      name: 'Heka Identity Verification',
      head_sha: sha,
      status: 'completed',
      conclusion: 'success',
      output: {
        title: 'Contributor Verified ✅',
        summary: `Identity of **@${username}** has been verified cryptographically.\n\n**Decentralized Identifier (DID):** \`${verificationResult.did}\``,
      },
    })
  } else {
    app.log.warn(`❌ Verification failed for @${username} — no valid credential found.`)

    // If the verification faced some issue, update the PR panel
    await context.octokit.checks.create({
      ...repoInfo,
      name: 'Heka Identity Verification',
      head_sha: sha,
      status: 'completed',
      conclusion: 'failure',
      output: {
        title: 'Unverified Contributor ❌',
        summary:
          `We could not verify a decentralized identity credential for **@${username}**.\n\nPlease onboard via the Heka Portal to receive your Verifiable Credential before contributing.`,
      },
    })
  }
}

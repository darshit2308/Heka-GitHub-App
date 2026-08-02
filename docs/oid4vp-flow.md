# OID4VP Verification Flow & API Contracts

**Week 6 — LFDT Mentorship 2026**  
**Status:** Design (finalized for mentor review before Week 7 implementation)

---

## Overview

This document defines the complete OpenID for Verifiable Presentations (OID4VP)
flow used to gate GitHub pull requests with contributor identity verification.

The three participants are:

| Participant | Role |
|---|---|
| **GitHub App** (Probot, existing) | Detects PRs, creates check runs, calls Heka |
| **heka-identity-service** (NestJS, this repo) | Session management, VP verification |
| **heka-chrome-extension** (new, this repo) | Holds contributor's credential, presents VP |

---

## 1. Complete End-to-End Flow

```
┌─────────────┐    PR opened / push     ┌───────────────┐
│  GitHub     │ ──────────────────────► │  GitHub App   │
│  (PR view)  │                         │  (Probot)     │
└──────┬──────┘                         └───────┬───────┘
       │                                        │
       │                       POST /api/v2/contributor/verify-request
       │                                        │
       │                                ┌───────▼────────────────┐
       │                                │  heka-identity-service  │
       │                                │  Creates session        │
       │                                │  state: pending         │
       │                                │  TTL: 10 minutes        │
       │                                └───────┬────────────────┘
       │                                        │
       │                    returns { sessionId, sessionUrl }
       │                                        │
       │◄───── check run created ───────────────┘
       │       details_url = sessionUrl
       │
       │  [Contributor sees check run in PR]
       │  [Clicks "Details" link]
       │
       │  → Opens: https://heka.example.com/verify/{sessionId}
       │           (Heka-hosted verification page)
       │
┌──────▼──────┐   GET /session/{id}   ┌───────────────────────┐
│  Heka       │ ──────────────────►   │  heka-identity-service │
│  verify     │ ◄── { state, def } ── │                       │
│  page       │                       └───────────────────────┘
└──────┬──────┘
       │
       │  Page detects extension is installed
       │  Sends: chrome.runtime.sendMessage({ type: 'PRESENT', sessionId, def })
       │
┌──────▼──────────────┐
│  heka-chrome-       │
│  extension          │
│  (popup opens)      │
│                     │
│  1. Load credential │
│     from storage    │
│  2. Apply selective │
│     disclosure      │
│  3. Sign holder     │
│     binding w/      │
│     WebCrypto key   │
│  4. Build vp_token  │
└──────┬──────────────┘
       │
       │  POST /api/v2/presentation/session/{id}/response
       │  body: vp_token=<sd-jwt-vp>
       │
┌──────▼─────────────────────────────────┐
│  heka-identity-service                  │
│                                         │
│  Verify VP:                             │
│  1. Parse SD-JWT VP                     │
│  2. Verify issuer sig (did:hedera key)  │
│  3. Verify holder binding (did:jwk key) │
│  4. Check githubAccountId === session's │
│  5. Update session → success/failure    │
│  6. Update GitHub check run via API     │
└──────┬──────────────────────────────────┘
       │
       │  Verification page polls GET /session/{id}
       │  ← { state: "success" }
       │
[GitHub PR check run → ✅ success]
[Verification page → "You're verified!"]
```

---

## 2. Session State Machine

```
                   ┌──────────┐
       created ──► │  pending │
                   └────┬─────┘
                        │ vp_token received
                   ┌────▼──────────┐
                   │  in_progress  │  (verifying, < 1 second)
                   └──┬─────────┬──┘
                      │         │
              valid   │         │  invalid
                 ┌────▼───┐  ┌──▼─────┐
                 │success │  │failure │
                 └────────┘  └────────┘

   (any state, if TTL exceeded)
                   ┌─────────┐
                   │ expired │  ← sweeper task
                   └─────────┘
```

### State Definitions

| State | Description | GitHub Check Run |
|---|---|---|
| `pending` | Session created, waiting for wallet presentation | `in_progress` |
| `in_progress` | `vp_token` received, backend verifying now | `in_progress` |
| `success` | VP valid, `githubAccountId` confirmed | ✅ `success` |
| `failure` | VP invalid or wrong account — see `failureReason` | ❌ `failure` |
| `expired` | TTL exceeded before any presentation | ❌ `failure` (timeout) |

### Failure Reason Codes (Machine-Readable)

| Code | Meaning |
|---|---|
| `invalid_vp_token` | VP token is malformed / cannot be parsed |
| `issuer_signature_invalid` | Issuer's SD-JWT signature verification failed |
| `holder_binding_invalid` | Holder binding proof signature failed |
| `account_id_mismatch` | `githubAccountId` in VC ≠ account ID on the PR |
| `credential_expired` | The VC's `exp` claim is in the past |
| `session_expired` | No presentation before TTL — set by sweeper |
| `credential_not_found` | No `GithubContributorCredential` found in VP |

---

## 3. TTL Policy and Background Sweeper

### Session TTL

- **Default TTL:** 10 minutes from session creation
- **Rationale:** Contributors need time to see the check run, understand what it
  is, open the link, and complete the flow. 10 minutes is generous but bounded.

### Sweeper Task

A background NestJS cron job runs every **60 seconds**:

```typescript
@Cron('*/60 * * * * *')
async sweepExpiredSessions(): Promise<void> {
  const expired = await this.em.find(PresentationSession, {
    state: SessionState.Pending,
    expiresAt: { $lt: new Date() }
  })
  for (const session of expired) {
    session.state = SessionState.Expired
    await this.githubAppClient.updateCheckRun(session.checkRunId, 'failure', 'Session expired')
  }
  await this.em.flush()
}
```

### Session Cleanup

Sessions in `success`, `failure`, or `expired` state are permanently deleted
after **24 hours** by a second cron job. Sessions are small (~500 bytes each),
so accumulation is not a concern for the prototype, but cleanup is good hygiene.

---

## 4. API Contracts

### 4.1 GitHub App → heka-identity-service

**Create a presentation session (called when a PR check run fires)**

```
POST /api/v2/contributor/verify-request
Authorization: Bearer <heka-github-app-secret>
Content-Type: application/json

{
  "githubAccountId": "12345678",
  "prNumber": 42,
  "repoFullName": "hiero-ledger/heka-identity-platform",
  "commitSha": "abc123def456abc123def456",
  "checkRunId": "987654321",
  "checkRunNodeId": "CR_kwDOA..."
}
```

**Response:**
```json
HTTP 201 Created
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "sessionUrl": "https://heka.example.com/verify/550e8400-e29b-41d4-a716-446655440000",
  "expiresAt": "2026-08-02T14:30:00.000Z"
}
```

**Error cases:**
- `409 Conflict` — A pending session already exists for this `commitSha` (idempotency guard)

---

### 4.2 heka-chrome-extension → heka-identity-service (polling)

**Get session state (polled every 2 seconds by the verification page and/or extension)**

```
GET /api/v2/presentation/session/:sessionId
```

**Response (pending — includes the presentation definition for the wallet):**
```json
HTTP 200 OK
{
  "sessionId": "550e8400-...",
  "state": "pending",
  "expiresAt": "2026-08-02T14:30:00.000Z",
  "presentationDefinition": {
    "id": "heka-contributor-verification",
    "input_descriptors": [
      {
        "id": "contributor-credential",
        "format": { "vc+sd-jwt": {} },
        "constraints": {
          "fields": [
            { "path": ["$.vct"], "filter": { "const": "https://hiero.ledger.org/vct/GithubContributorCredential" } },
            { "path": ["$.githubAccountId"] }
          ]
        }
      }
    ]
  }
}
```

**Response (terminal states):**
```json
HTTP 200 OK
{
  "sessionId": "550e8400-...",
  "state": "success" | "failure" | "expired",
  "failureReason": null | "account_id_mismatch" | "issuer_signature_invalid" | ...
}
```

---

### 4.3 heka-chrome-extension → heka-identity-service (submission)

**Submit the Verifiable Presentation (OID4VP `direct_post` response mode)**

```
POST /api/v2/presentation/session/:sessionId/response
Content-Type: application/x-www-form-urlencoded

vp_token=eyJhb...&presentation_submission=%7B%22id%22%3A%22...%22%7D
```

**Successful response:**
```json
HTTP 200 OK
{
  "redirectUri": "https://heka.example.com/verify/550e8400-..."
}
```

**Error responses:**

| HTTP | Body | Meaning |
|---|---|---|
| `400` | `{ "error": "invalid_vp_token" }` | Malformed VP |
| `400` | `{ "error": "session_not_found" }` | Unknown session ID |
| `409` | `{ "error": "session_already_completed" }` | Already success/failure |
| `410` | `{ "error": "session_expired" }` | TTL exceeded |

---

## 5. GitHub UX Delivery Mechanism

### Check Run Setup (GitHub App side)

When creating the check run, the GitHub App sets:

```javascript
await octokit.rest.checks.create({
  owner, repo,
  name: 'Heka Identity Verification',
  head_sha: commitSha,
  status: 'in_progress',
  details_url: sessionUrl,   // ← The Heka verification page URL
  output: {
    title: 'Contributor Identity Verification Required',
    summary: [
      'This pull request requires identity verification.',
      '',
      'Click **Details** to verify your contributor credential using the Heka wallet.',
      '',
      `Session expires at: ${expiresAt}`
    ].join('\n')
  }
})
```

GitHub renders the "Details" link next to the check run in the PR's checks
section. The contributor clicks it and lands on the Heka verification page.

### Verification Page UI States

The verification page (`/verify/:sessionId`) is a Heka-hosted web page. It:

1. Polls `GET /api/v2/presentation/session/:sessionId` every **2 seconds**
2. Detects whether the extension is installed via
   `chrome.runtime.sendMessage({ type: 'PING' })` (fails gracefully if not installed)
3. Updates UI based on state:

| State | What the contributor sees |
|---|---|
| Loading | Spinner |
| `pending` — extension not installed | "Install the Heka Extension" + download link |
| `pending` — no credential in extension | "You need a credential first" → link to receive flow |
| `pending` — credential found | "Present your contributor credential" button |
| `in_progress` | "Verifying your credential..." |
| `success` | "✅ Verified! Your PR check has passed." |
| `failure` | "❌ Verification failed: [human-readable reason]" + retry button |
| `expired` | "Session expired. Return to your PR and open a new check." |

### Polling Logic

```
Poll interval: 2 seconds (flat) for first 60 seconds
After 60 seconds: 5 second interval (backoff)
Stop polling on: success | failure | expired state
Maximum poll duration: session TTL (10 minutes)
```

---

## 6. OID4VP Authorization Request Structure

The `presentationDefinition` sent to the wallet (see §4.2) uses the
**Presentation Exchange v2** format:

```json
{
  "id": "heka-contributor-verification-<sessionId>",
  "input_descriptors": [
    {
      "id": "github-contributor-credential",
      "name": "GitHub Contributor Credential",
      "purpose": "Verify that you are an authenticated Hiero contributor",
      "format": {
        "vc+sd-jwt": {
          "sd-jwt_alg_values": ["ES256"]
        }
      },
      "constraints": {
        "limit_disclosure": "required",
        "fields": [
          {
            "path": ["$.vct"],
            "filter": {
              "type": "string",
              "const": "https://hiero.ledger.org/vct/GithubContributorCredential"
            }
          },
          {
            "path": ["$.githubAccountId"],
            "intent_to_retain": false
          },
          {
            "path": ["$.verifiedAt"],
            "intent_to_retain": false
          }
        ]
      }
    }
  ]
}
```

**Notes:**
- `limit_disclosure: required` forces the wallet to use SD-JWT selective
  disclosure — the wallet **must not** reveal claims not requested
- Only `githubAccountId` and `verifiedAt` are required to be revealed
- `githubUsername` and `gpgFingerprint` are selectively disclosable per the
  Week 2 policy — the contributor may reveal them but is not required to

---

## 7. Policy Engine Inputs

When Heka verifies the received VP, it runs the following policy checks in order:

```
1. PARSE        Is the vp_token a valid SD-JWT?
                   No → failure: invalid_vp_token

2. ISSUER SIG   Does the issuer signature verify against the GithubContributorCredential
                issuer's did:hedera DID document?
                   No → failure: issuer_signature_invalid

3. HOLDER BIND  Does the holder binding proof verify against the holder's did:jwk?
                   No → failure: holder_binding_invalid

4. CREDENTIAL   Does the credential type (vct) match GithubContributorCredential?
                   No → failure: credential_not_found

5. EXPIRY       Is the credential's exp claim in the future?
                   No → failure: credential_expired

6. ACCOUNT ID   Does vc.githubAccountId === session.githubAccountId?
                   No → failure: account_id_mismatch

7. PASS         All checks pass → success
```

---

## 8. Database Schema (to be implemented in Week 7)

```typescript
// New entity: PresentationSession
@Entity()
export class PresentationSession {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID()

  @Enum(() => SessionState)
  state: SessionState = SessionState.Pending

  @Property()
  githubAccountId: string               // account ID from the PR

  @Property()
  repoFullName: string                  // e.g. "hiero-ledger/heka-identity-platform"

  @Property()
  prNumber: number

  @Property()
  commitSha: string                     // idempotency key

  @Property()
  checkRunId: string

  @Property({ nullable: true })
  failureReason?: string                // machine-readable reason code

  @Property()
  expiresAt: Date                       // createdAt + 10 minutes

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ onUpdate: () => new Date(), nullable: true })
  resolvedAt?: Date
}

export enum SessionState {
  Pending = 'pending',
  InProgress = 'in_progress',
  Success = 'success',
  Failure = 'failure',
  Expired = 'expired',
}
```

---

## 9. Open Items for Mentor Review

- [ ] Confirm `presentationDefinition` format (Presentation Exchange v2 vs. DCQL)
- [ ] Confirm `did:jwk` is acceptable for holder DID binding
- [ ] Confirm the verification page lives in `heka-identity-service-web-ui/`
      or gets a new dedicated page in `heka-identity-service` itself
- [ ] Confirm GitHub App auth between GitHub App and Heka (shared secret vs. JWT)
- [ ] Any preference on the sweeper cron interval (60s is assumed)?

# Web Wallet Architecture: Chrome Extension Design

**Week 6 — LFDT Mentorship 2026**  
**Status:** Design (finalized for mentor review before Week 7 implementation)

---

## Decision Record

| Decision | Choice | Rationale |
|---|---|---|
| Wallet type | Chrome Extension (Manifest V3) | Per mentor direction |
| Key management | WebCrypto API + `chrome.storage.local` | No Askar in browser (see §2) |
| Repository | `heka-identity-platform` monorepo | Per mentor direction |
| Directory | `heka-chrome-extension/` (new, root-level) | Consistent with existing package naming |
| Holder DID method | `did:jwk` | Self-contained, no network needed |
| Linked VP fallback | Sketched, deferred | Only if extension proves infeasible |

---

## 1. Why a Chrome Extension

The Web Wallet is implemented as a Manifest V3 Chrome extension rather than a
hosted web page because it:

- Persists key material and credentials **across browser sessions** without
  requiring a server-side account
- Can be invoked from any page (including `github.com`) without a redirect
- Allows the holder's private key to stay **device-local** — never touches Heka's
  servers
- Enables the standard wallet UX pattern (a badge in the toolbar, an extension
  popup for consent)

---

## 2. Key Management — WebCrypto + `chrome.storage.local` (Non-Askar)

### Why Not Askar

`@credo-ts/askar` uses Rust FFI native bindings
(`@hyperledger/aries-askar-nodejs`, `aries-askar-react-native`). These bindings
do not work in browser environments. There is no production-ready WASM build of
Askar for browsers as of 2025. The extension **must not** use Askar.

### Key Generation

On first install the extension generates an **ECDSA P-256 key pair** using
the browser's built-in WebCrypto API:

```typescript
const keyPair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,          // extractable: false — raw bytes never leave the browser
  ['sign', 'verify']
)
```

`extractable: false` means the private key bytes **cannot be exported** via
`exportKey()`. Even if an attacker reads `chrome.storage.local`, they get a
serialized `CryptoKey` handle, not the raw key material.

### Storage

`CryptoKey` objects are structured-cloneable and can be stored directly in
IndexedDB. The extension uses IndexedDB (scoped to the extension's own origin,
`chrome-extension://<id>`) rather than `chrome.storage.local` for the actual
key pair, because `chrome.storage.local` does **not** support structured clone
of `CryptoKey` objects in all browsers.

Credential records (the issued SD-JWT VC string) are stored in
`chrome.storage.local` as plain strings — they are not secret (the VC is
signed by the issuer; confidentiality comes from selective disclosure at
presentation time, not storage-time encryption).

```
IndexedDB (chrome-extension://<id>)
  └── store: "wallet-keys"
        └── { id: "holder-key-v1", publicKey: CryptoKey, privateKey: CryptoKey }

chrome.storage.local
  └── "held-credentials": [{ id, sdJwtVc, receivedAt, issuer }]
  └── "holder-did": "did:jwk:..."
```

### Holder DID

The holder's DID is derived deterministically from the public key:

```typescript
const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
const holderDid = `did:jwk:${base64url(JSON.stringify(publicJwk))}`
```

`did:jwk` is self-contained — no Hedera network, no registry, no DNS. The
verifier (Heka backend) can resolve the DID directly from the DID string itself.

---

## 3. Manifest V3 Service Worker Lifecycle Evaluation

### The Constraint

Manifest V3 service workers terminate after **~30 seconds of idle** time. They
cannot be made persistent. Global variables are lost on termination.

### Why This Is Not a Problem for This Flow

The OID4VP signing operation consists of:

1. **User consent UI** — runs in the **extension popup** (a full DOM page, no
   timeout)
2. **Cryptographic signing** — `crypto.subtle.sign()` takes **< 5 ms**
3. **HTTP POST of vp_token** — a single fetch, takes **< 2 s** under normal
   network conditions

The service worker only needs to be alive for steps 2 and 3 — both are
instantaneous. The user-facing consent step (which could take minutes) happens
entirely inside the popup, which is not subject to the service worker lifecycle.

**Architecture:** The popup page drives the flow. When the user clicks "Present",
the popup calls `crypto.subtle.sign()` directly (WebCrypto is available in popup
pages), then POSTs the `vp_token` to Heka. The service worker is only used for:
- Receiving external messages (e.g. from the Heka verification page's content)
- Storing/retrieving credentials from `chrome.storage`

Both operations complete in well under 30 seconds.

### State Persistence Across SW Restarts

All persistent state lives in `chrome.storage` or IndexedDB, not in JS globals.
If the service worker restarts mid-session, the popup page re-reads state from
storage and continues. No data is lost.

---

## 4. Credo-ts Browser Integration — Gap Analysis

The plan requires an explicit evaluation of how (or whether) Credo-ts fits into
the browser-based extension, and where its server-side assumptions break down.

### What Credo-ts Assumes (Server-Side Agent Model)

Credo-ts is designed around a **long-lived, persistent agent** that:

| Assumption | Server Reality | Browser Extension Reality |
|---|---|---|
| **Storage** | Askar (SQLite/PostgreSQL via native FFI) | No native bindings available |
| **Key management** | Askar KMS (Rust-backed) | Must use WebCrypto API instead |
| **Crypto primitives** | `@credo-ts/askar` WASM/native | WebCrypto `SubtleCrypto` |
| **Agent lifecycle** | Persistent Node.js process | SW terminates after 30s idle |
| **DIDComm transport** | HTTP server listener + WebSocket | Not available in browser SW |
| **Module system** | CommonJS / Node.js `require()` | Must be ESM, no `node:*` APIs |
| **Buffer / streams** | Node.js built-in | Needs polyfills or avoid entirely |

### Specific Gaps Identified

#### Gap 1: Askar Storage Module (BLOCKING for key management)
`@credo-ts/askar` pulls in `@hyperledger/aries-askar-nodejs` which uses
`node-gyp` native addons. These **cannot run in a browser**. There is no
official WASM Askar build as of 2025. Any use of `AskarModule` in the
extension will fail at bundle time.

**Resolution:** Do not use `AskarModule`. Use WebCrypto + IndexedDB directly
(see §2). The extension does not need Askar.

#### Gap 2: Agent Initialization Cost
A full Credo-ts agent initializes connections to DID resolvers, loads modules,
and opens a wallet — typically taking **2–5 seconds**. In a popup page that
opens on demand, this delay would be jarring UX.

**Resolution:** Do not initialize a full Credo-ts agent in the extension.
Use lightweight, framework-agnostic libraries instead:
- **SD-JWT VP construction:** `@sd-jwt/sd-jwt-vc` (browser-native, no agent needed)
- **DID resolution:** `did-resolver` + `did-method-jwk` (small, browser-compatible)
- **Holder binding proof:** `WebCrypto SubtleCrypto` directly

#### Gap 3: Node.js Built-ins (`crypto`, `buffer`, `stream`)
Several Credo-ts modules import from `node:crypto`, `node:buffer`, or
`node:stream`. Bundlers (Vite/Webpack) can polyfill `buffer` but `node:crypto`
cannot be fully polyfilled in an extension — WebCrypto has a different API
surface and some algorithms differ.

**Resolution:** Avoid importing Credo-ts modules that depend on `node:crypto`
in the extension bundle. The only Credo-ts module that would be safe to use
(if needed) is `@credo-ts/core` for type definitions only — never for runtime.

#### Gap 4: DIDComm Transport
Credo-ts assumes the agent can **receive** DIDComm messages via an HTTP
endpoint or WebSocket server. A browser extension has no inbound network
listener — it can only initiate outbound connections.

**Resolution:** The extension does not use DIDComm at all. The OID4VCI and
OID4VP protocols are HTTP-based client-initiated flows only. The extension
makes outbound `fetch()` calls. No DIDComm transport is needed.

### What We Use Instead of Credo-ts in the Extension

| Credo-ts module | Browser replacement |
|---|---|
| `AskarModule` | WebCrypto + IndexedDB |
| `OpenId4VcHolderModule` | `@sd-jwt/sd-jwt-vc` (direct) |
| DID resolution | `did-resolver` + `did-method-jwk` |
| Key signing | `crypto.subtle.sign()` |
| Credential storage | `chrome.storage.local` (plain string) |

### Where Credo-ts DOES Still Apply

Credo-ts continues to be used **server-side** in `heka-identity-service` for:
- Issuing the `GithubContributorCredential` (Week 5)
- Verifying the received `vp_token` in the OID4VP response endpoint (Week 7–8)
- DID resolution of the issuer's `did:hedera` for signature verification

The extension is a **lightweight holder** — it does not need the full agent
stack. The Credo-ts agent stack lives entirely on the server side, which is
exactly what its design assumes.

---

## 5. Extension Directory Structure

```
heka-chrome-extension/
├── manifest.json           ← Manifest V3
├── package.json
├── tsconfig.json
├── vite.config.ts          ← Vite bundles each entry point separately
├── src/
│   ├── background/
│   │   └── service-worker.ts   ← Handles chrome.runtime.onMessage
│   ├── popup/
│   │   ├── index.html
│   │   └── Popup.tsx           ← React: consent UI, receive credential UI
│   ├── content-scripts/
│   │   └── github.ts           ← Detects Heka check run on github.com PRs
│   ├── wallet/
│   │   ├── key-store.ts        ← WebCrypto key gen + IndexedDB persistence
│   │   ├── credential-store.ts ← chrome.storage credential CRUD
│   │   └── did.ts              ← did:jwk derivation from public key
│   ├── oid4vci/
│   │   └── receive.ts          ← Handles openid-credential-offer:// flow
│   └── oid4vp/
│       ├── build-vp.ts         ← SD-JWT VP construction + holder binding
│       └── present.ts          ← POST vp_token to Heka response_uri
├── __tests__/
│   └── wallet/
│       ├── key-store.test.ts
│       └── build-vp.test.ts
└── docs/
    └── local-setup.md
```

---

## 6. Credential Receive Flow (OID4VCI)

When the contributor is issued their `GithubContributorCredential` from Heka
(via the `POST /v2/contributor-credential/offer` endpoint implemented in Week 5),
the response is an `openid-credential-offer://` URI.

**Receiving path:**

1. The Heka verification page (or the extension popup, if opened manually)
   displays the offer URI as a button: "Receive in Extension"
2. The page calls `chrome.runtime.sendMessage({ type: 'RECEIVE_OFFER', offerUri })`
3. The extension service worker receives the message and opens the popup
4. The popup parses the offer, fetches the credential from Heka's token endpoint,
   and stores the SD-JWT VC string in `chrome.storage.local`

The extension registers `openid-credential-offer` as a URL scheme handler in
`manifest.json` so it can also receive offers via direct browser navigation:

```json
"protocol_handlers": [
  { "protocol": "openid-credential-offer", "uriTemplate": "/src/popup/index.html?offer=%s" }
]
```

---

## 7. Linked VP Fallback — Deferred Sketch

**Only to be considered if the Chrome Extension proves infeasible.**

The Linked VP approach: the contributor signs a Verifiable Presentation and
hosts it at a stable public URL. The GitHub App fetches that URL directly
instead of running an interactive OID4VP flow.

**Known problems:**
- Pre-signed VPs cannot prove per-PR holder binding (no `nonce` in the proof)
- The VP goes stale as credentials expire or are updated
- Requires contributors to manually host and rotate the VP file
- GitHub App must trust a contributor-controlled URL

**Conclusion:** This is a meaningful fallback only if the extension has
platform-level problems (e.g., Chrome Web Store rejection, Firefox
incompatibility). For the prototype scope, the extension approach is sound.
This sketch is documented here as a reference and will not be implemented unless
the mentor directs otherwise.

---

## 8. Open Items for Mentor Review

- [ ] Confirm extension builds as `heka-chrome-extension/` at repo root
- [ ] Confirm `did:jwk` is acceptable for the holder DID (vs. `did:key` or `did:peer`)
- [ ] Confirm the popup-drives-signing architecture is acceptable
  (service worker is NOT in the signing path)

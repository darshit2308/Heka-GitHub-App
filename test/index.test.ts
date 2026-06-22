import nock from "nock";
import myProbotApp from "../src/index.js";
import { Probot, ProbotOctokit } from "probot";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, beforeEach, afterEach, test, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const privateKey = fs.readFileSync(
  path.join(__dirname, "fixtures/mock-cert.pem"),
  "utf-8",
);

const payload = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/pull_request.opened.json"),
    "utf-8",
  ),
);

describe("Heka Identity Verification Bot", () => {
  let probot: any;

  beforeEach(() => {
    nock.disableNetConnect();
    probot = new Probot({
      appId: 123,
      privateKey,
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });
    probot.load(myProbotApp);
  });

  test("creates a success check when Heka returns a valid credential", async () => {
    const mock = nock("https://api.github.com")
      // Probot requests an installation access token
      .post("/app/installations/2/access_tokens")
      .reply(200, {
        token: "test",
        permissions: { checks: "write" },
      })

      // First check: in_progress
      .post("/repos/test-org/test-repo/check-runs", (body: any) => {
        expect(body.name).toBe("Heka Identity Verification");
        expect(body.head_sha).toBe("abc123def456");
        expect(body.status).toBe("in_progress");
        return true;
      })
      .reply(201)

      // Second check: completed + success
      .post("/repos/test-org/test-repo/check-runs", (body: any) => {
        expect(body.name).toBe("Heka Identity Verification");
        expect(body.status).toBe("completed");
        expect(body.conclusion).toBe("success");
        expect(body.output.title).toContain("Verified");
        return true;
      })
      .reply(201);

    // Mock the Heka identity service returning a valid credential
    const hekaMock = nock("http://localhost:3000")
      .post("/verify", { github_username: "test-contributor" })
      .reply(200, {
        isValid: true,
        did: "did:key:z6MkTestContributorDid123",
      });

    await probot.receive({ name: "pull_request", payload });

    expect(mock.pendingMocks()).toStrictEqual([]);
    expect(hekaMock.pendingMocks()).toStrictEqual([]);
  });

  test("creates a failure check when Heka returns an invalid credential", async () => {
    const mock = nock("https://api.github.com")
      // Probot requests an installation access token
      .post("/app/installations/2/access_tokens")
      .reply(200, {
        token: "test",
        permissions: { checks: "write" },
      })

      // First check: in_progress
      .post("/repos/test-org/test-repo/check-runs", (body: any) => {
        expect(body.status).toBe("in_progress");
        return true;
      })
      .reply(201)

      // Second check: completed + failure
      .post("/repos/test-org/test-repo/check-runs", (body: any) => {
        expect(body.status).toBe("completed");
        expect(body.conclusion).toBe("failure");
        expect(body.output.title).toContain("Unverified");
        return true;
      })
      .reply(201);

    // Mock the Heka identity service returning no valid credential
    const hekaMock = nock("http://localhost:3000")
      .post("/verify", { github_username: "test-contributor" })
      .reply(200, {
        isValid: false,
      });

    await probot.receive({ name: "pull_request", payload });

    expect(mock.pendingMocks()).toStrictEqual([]);
    expect(hekaMock.pendingMocks()).toStrictEqual([]);
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });
});

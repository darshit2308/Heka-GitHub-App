# mock-heka-bot

> A GitHub App built with [Probot](https://github.com/probot/probot) that LFDT Identity Verification Bot

## Setup

```sh
# Install dependencies
npm install

# Copy and fill local configuration
cp .env.example .env

# Build the production entrypoint
npm run build

# Run the bot locally
npm start
```

For local Week 3 fixture testing, run the services on separate ports:

- `heka-identity-service`: `http://localhost:3000`
- `heka-GitHub-app`: `http://localhost:3001`

Set the GitHub App webhook URL to your tunnel URL plus Probot's webhook path:

```txt
https://<your-tunnel-host>/api/github/webhooks
```

If the GitHub App is configured with only the tunnel root URL, GitHub will receive
`404` responses because Probot does not receive webhooks at `/` by default.
The local tunnel should forward to the GitHub App port (`3001`), not the Heka
identity-service port (`3000`).

The GitHub App calls Heka through `HEKA_SERVICE_URL`, which should remain
`http://localhost:3000` for the default local Heka service.

## Docker

```sh
# 1. Build container
docker build -t mock-heka-bot .

# 2. Start container
docker run \
  -e APP_ID=<app-id> \
  -e PRIVATE_KEY=<pem-value> \
  -e WEBHOOK_SECRET=<webhook-secret> \
  -e PORT=3001 \
  -e HEKA_SERVICE_URL=http://host.docker.internal:3000 \
  -p 3001:3001 \
  mock-heka-bot
```

## Contributing

If you have suggestions for how mock-heka-bot could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2026 darshit2308

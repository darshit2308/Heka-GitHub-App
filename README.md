# mock-heka-bot

> A GitHub App built with [Probot](https://github.com/probot/probot) that LFDT Identity Verification Bot

## Setup

```sh
# Install dependencies
npm install

# Run the bot
npm start
```

## Docker

```sh
# 1. Build container
docker build -t mock-heka-bot .

# 2. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> mock-heka-bot
```

## Contributing

If you have suggestions for how mock-heka-bot could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2026 darshit2308

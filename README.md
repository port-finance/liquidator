# 💸 Port Finance Loan Liquidator

### Prerequisites

To run the liquidator you will need:

- A Solana account with some SOL deposited to cover transaction fees
- Token accounts for each token in the reserve
- Roughly equal dollar value for each token.

### Deploy

Make sure to add the `~/.config/solana/id` file to look something like this, and run the command:

```
# cat ~/.config/solana/id
KEYPAIR=YourBase58KeyPair
ALERT_WEBHOOK_URL=
HEARTBEAT_WEBHOOK_URL=

# Run
cd deploy
./deploy.sh apply
```

`CHECK_INTERVAL` is the amount of milliseconds to wait between querying users' loans

### Run with pnpm

```
# Before run with pnpm locally, make sure you setup the environment variable correctly.
pnpm install
pnpm start
```

### Contribution

We welcome contributions. Substantial contribution is eligible for PORT token or USD rewards.

### Support

Need help? You can find us on the Port Finance Discord:

[![Discord Chat](https://img.shields.io/discord/842990920081473586?color=blueviolet)](https://discord.gg/Yky8ZwdEN2)

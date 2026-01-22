# Polymarket Copy Trading Bot

Automatically copy trades from smart money traders on Polymarket with Discord notifications.

## Setup

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Configure Environment Variables

Edit `.env` and add your credentials:

```bash
# Polymarket Private Key (REQUIRED for trading)
PRIVATE_KEY=your_private_key_here

# Discord Webhook URL (OPTIONAL - for trade notifications)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your_webhook_url_here
```

#### How to get Discord Webhook URL:
1. Open your Discord server
2. Go to the channel where you want notifications
3. Click the gear icon (Edit Channel)
4. Go to **Integrations** → **Webhooks**
5. Click **New Webhook**
6. Copy the webhook URL
7. Paste it in your `.env` file

**⚠️ Keep this URL private** - anyone with it can post to your channel.

### 3. Configure Trading Parameters

Edit `scripts/smart-money/04-auto-copy-trading.ts` to customize:

```typescript
const DRY_RUN = false;              // Set to true for testing without real trades
const SIZE_SCALE = 0.1;             // Copy 10% of their trade size
const MAX_SIZE_PER_TRADE = 10;      // Max $10 per trade
const MAX_SLIPPAGE = 0.03;          // 3% slippage tolerance
const RUN_DURATION_MS = 2 * 60 * 1000; // Run for 2 minutes

// Target wallet addresses to follow
const addressList = ["0x6297b93ea37ff92a57fd636410f3b71ebf74517e"];
```

## Running the Bot

### Using npm script:
```bash
pnpm run copy-trade
```

### Or directly:
```bash
pnpm exec tsx scripts/smart-money/04-auto-copy-trading.ts
```

## Features

- ✅ **Automatic Copy Trading**: Instantly copy trades from specified smart money wallets
- ✅ **Discord Notifications**: Get real-time updates on:
  - Bot startup/shutdown
  - Trade executions (success/failure)
  - Errors and warnings
  - Session statistics
- ✅ **Risk Management**:
  - Configurable size scaling
  - Maximum trade size limits
  - Slippage protection
  - Minimum trade size filtering
- ✅ **Dry Run Mode**: Test without executing real trades
- ✅ **Detailed Logging**: Console output + Discord notifications

## Discord Notification Examples

When a trade is copied, you'll receive messages like:

```
**Copy Trade ✅ SUCCESS**
Trader: `0x6297b93ea37ff92a57fd636410f3b71ebf74517e`
Market: will-trump-win-2024
BUY Yes @ $0.6250 (size: $10.00)
OrderId: `abc123...`
```

When the session ends:

```
📊 **Copy Trading Session Complete**
Duration: 120s
Detected: 5 | Executed: 3
Skipped: 1 | Failed: 1
Total Spent: $25.50
```

## Safety Tips

1. **Start with Dry Run**: Set `DRY_RUN = true` first to test
2. **Use Small Amounts**: Start with small `MAX_SIZE_PER_TRADE` values
3. **Monitor Discord**: Keep an eye on your notification channel
4. **Keep Keys Private**: Never commit `.env` to git

## Troubleshooting

### "PRIVATE_KEY not found"
- Make sure `.env` file exists in project root
- Check that `PRIVATE_KEY` is set in `.env`

### "Discord webhook failed"
- Verify webhook URL is correct
- Make sure the webhook hasn't been deleted in Discord
- The bot will continue working even if Discord fails

### No trades being detected
- Check that your target addresses are active traders
- Verify WebSocket connection is established
- Increase `RUN_DURATION_MS` for longer monitoring

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

# ===== TRADE SIGNAL BOT: Multi-Node Broadcast (OPTIONAL) =====
# For advanced users: Route different addresses to different Discord webhooks
# If not set, trade_signal_bot.ts uses legacy mode (TARGET_ADDRESSES + DISCORD_WEBHOOK_URL)

# Define your webhook URLs (one per node)
DISCORD_WEBHOOK_NODE_A=https://discord.com/api/webhooks/your_webhook_a
DISCORD_WEBHOOK_NODE_B=https://discord.com/api/webhooks/your_webhook_b
DISCORD_WEBHOOK_NODE_C=https://discord.com/api/webhooks/your_webhook_c

# Configure routing: JSON array mapping nodes to target addresses
# Format: [{"name":"NodeName","webhookEnvKey":"DISCORD_WEBHOOK_NODE_X","targets":["0x..."]}]
# Note: Each address can only belong to ONE node (1-to-1 mapping enforced)
BROADCAST_NODES_JSON=[{"name":"SmartMoney","webhookEnvKey":"DISCORD_WEBHOOK_NODE_A","targets":["0x6297b93ea37ff92a57fd636410f3b71ebf74517e"]},{"name":"WhaleTracker","webhookEnvKey":"DISCORD_WEBHOOK_NODE_B","targets":["0xabc123..."]}]
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
- ✅ **Multi-Node Broadcast** (Trade Signal Bot): Route different trader addresses to different Discord webhooks
- ✅ **Risk Management**:
  - Configurable size scaling
  - Maximum trade size limits
  - Slippage protection
  - Minimum trade size filtering
- ✅ **Dry Run Mode**: Test without executing real trades
- ✅ **Detailed Logging**: Console output + Discord notifications

## Trade Signal Bot: Multi-Node Configuration

The trade signal bot (`scripts/trade_signal_bot.ts`) supports routing different trader addresses to different Discord channels via webhook URLs.

### Legacy Mode (Single Webhook)
By default, if `BROADCAST_NODES_JSON` is not set, the bot uses:
- `TARGET_ADDRESSES` array in the script (hardcoded)
- `DISCORD_WEBHOOK_URL` from `.env`

All monitored addresses send notifications to the same webhook.

### Multi-Node Mode (Advanced)
Configure `BROADCAST_NODES_JSON` to route specific addresses to specific webhooks:

```bash
# In .env - define webhook URLs
DISCORD_WEBHOOK_SMARTMONEY=https://discord.com/api/webhooks/xxx
DISCORD_WEBHOOK_WHALES=https://discord.com/api/webhooks/yyy
DISCORD_WEBHOOK_DEGEN=https://discord.com/api/webhooks/zzz

# Configure routing (must be valid JSON on one line)
BROADCAST_NODES_JSON=[{"name":"SmartMoney","webhookEnvKey":"DISCORD_WEBHOOK_SMARTMONEY","targets":["0x6297b93ea37ff92a57fd636410f3b71ebf74517e","0xabc..."]},{"name":"Whales","webhookEnvKey":"DISCORD_WEBHOOK_WHALES","targets":["0xdef..."]},{"name":"DegenPlays","webhookEnvKey":"DISCORD_WEBHOOK_DEGEN","targets":["0x123..."]}]
```

**Node Configuration Fields:**
- `name`: Friendly name for the broadcast node (shown in logs)
- `webhookEnvKey`: Name of the env var containing the Discord webhook URL
- `targets`: Array of wallet addresses to route to this webhook

**Important Rules:**
- ✅ Each address can only belong to **ONE** node (1-to-1 mapping enforced)
- ✅ If an address appears in multiple nodes, the bot will exit with an error
- ✅ All addresses must be valid Ethereum addresses (`0x` + 40 hex chars)
- ✅ Startup/shutdown messages are sent to **all** configured webhooks

**Why Multi-Node?**
- Separate Discord channels for different trader categories (smart money, whales, degen plays)
- Team collaboration: different members monitor different traders
- Testing: production vs. staging webhooks

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

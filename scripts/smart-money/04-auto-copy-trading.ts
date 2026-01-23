/**
 * Auto Copy Trading Test - Automatically Copy Smart Money Trades
 *
 * Simplified copy trading: Start auto-copy trading with one line of code
 * - Track top traders from leaderboard
 * - Instantly copy trades when smart money traders execute
 * - Supports dry run mode for testing
 * - Discord webhook notifications
 *
 * Run: pnpm exec tsx scripts/smart-money/04-auto-copy-trading.ts
 */

import 'dotenv/config';
import {
  SmartMoneyService,
  WalletService,
  RealtimeServiceV2,
  TradingService,
  DataApiClient,
  SubgraphClient,
  RateLimiter,
  createUnifiedCache,
} from '@catalyst-team/poly-sdk';

// ============================================================
// CONFIGURATION - Edit these values to customize your bot
// ============================================================

// Trading Mode
const DRY_RUN = false;                    // true = test mode (no real trades), false = live trading

// Trade Sizing
const SIZE_SCALE = 1;                     // Percentage of their trade size to copy (1 = 100%, 0.1 = 10%)
const MAX_SIZE_PER_TRADE = 10;            // Maximum USDC per trade (safety limit)
const MIN_TRADE_SIZE = 0.1;                // Minimum trade size to copy (filter small trades)

// Risk Management
const MAX_SLIPPAGE = 0.03;                // Maximum slippage tolerance (0.03 = 3%)
const ORDER_TYPE = 'FOK';                 // FOK = Fill or Kill, FAK = Fill and Kill

// WebSocket Management
const RECONNECT_MS = 60000;              // Reconnect WebSocket every 60 seconds

// Target Wallets - Add addresses to follow
const TARGET_ADDRESSES = [
  "0x6297b93ea37ff92a57fd636410f3b71ebf74517e"
];

// ============================================================
// DO NOT EDIT BELOW THIS LINE (unless you know what you're doing)
// ============================================================

/**
 * Discord Webhook Notifier
 * Sends messages to Discord channel via webhook URL
 * Queues messages to avoid rate limits
 */
function createDiscordWebhookNotifier(webhookUrl: string) {
  let queue = Promise.resolve();

  async function post(content: string) {
    // Discord content limit is 2000 chars
    const safe = content.length > 1900 ? content.slice(0, 1900) + '…' : content;

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: safe }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Discord webhook failed: ${res.status} ${text}`);
    }
  }

  return {
    notify(content: string) {
      queue = queue.then(() => post(content)).catch((e) => {
        // avoid crashing trading due to Discord issues
        console.error('[Discord Error]', e?.message || e);
      });
    },
  };
}

async function main() {
  console.log('='.repeat(60));
  console.log('🤖 Auto Copy Trading - Smart Money Follower');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? '🧪 DRY RUN (No real trades)' : '💰 LIVE TRADING'}`);
  console.log(`Following: ${TARGET_ADDRESSES.length} wallet(s)`);
  console.log(`Size Scale: ${SIZE_SCALE * 100}%`);
  console.log(`Max per trade: $${MAX_SIZE_PER_TRADE}`);
  console.log(`Min trade size: $${MIN_TRADE_SIZE}`);
  console.log(`Reconnect interval: ${RECONNECT_MS / 1000}s`);
  console.log('='.repeat(60));

  // Check for private key
  const privateKey = process.env.PRIVATE_KEY || process.env.POLY_PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ PRIVATE_KEY or POLY_PRIVATE_KEY not found in .env');
    process.exit(1);
  }

  // Initialize Discord notifier (optional)
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const discord = webhookUrl ? createDiscordWebhookNotifier(webhookUrl) : null;
  
  if (discord) {
    console.log('✅ Discord webhook configured');
  } else {
    console.log('⚠️  No Discord webhook configured (set DISCORD_WEBHOOK_URL in .env)');
  }

  // Initialize services
  console.log('\n[Init] Initializing services...');
  const cache = createUnifiedCache();
  const rateLimiter = new RateLimiter();
  const dataApi = new DataApiClient(rateLimiter, cache);
  const subgraph = new SubgraphClient(rateLimiter, cache);
  const walletService = new WalletService(dataApi, subgraph, cache);
  const realtimeService = new RealtimeServiceV2();
  const tradingService = new TradingService(rateLimiter, cache, {
    privateKey,
    chainId: 137,
  });

  const smartMoneyService = new SmartMoneyService(
    walletService,
    realtimeService,
    tradingService
  );

  const ourAddress = tradingService.getAddress().toLowerCase();
  console.log(`  Our wallet: ${ourAddress.slice(0, 10)}...${ourAddress.slice(-6)}`);

  // Helper: Connect to WebSocket
  async function connectRealtime() {
    console.log('\n[WebSocket] Connecting...');
    realtimeService.connect();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      realtimeService.once('connected', () => {
        clearTimeout(timeout);
        console.log('  ✅ WebSocket connected');
        resolve();
      });
    });
  }

  // Helper: Start auto copy trading subscription
  async function startAutoCopy() {
    console.log('\n[Auto Copy Trading] Starting auto copy trading...');

    const subscription = await smartMoneyService.startAutoCopyTrading({
      // specify target addresses to follow
      targetAddresses: TARGET_ADDRESSES,

      // Copy trading configuration
      sizeScale: SIZE_SCALE,
      maxSizePerTrade: MAX_SIZE_PER_TRADE,
      maxSlippage: MAX_SLIPPAGE,
      orderType: ORDER_TYPE,

      // Filters
      minTradeSize: MIN_TRADE_SIZE,

      // Dry run mode
      dryRun: DRY_RUN,

      // Callbacks
      onTrade: (trade, result) => {
        console.log('\n📈 Copy Trade Executed:');
        console.log(`  Trader: ${trade.traderName || trade.traderAddress.slice(0, 10)}...`);
        console.log(`  Market: ${trade.marketSlug}`);
        console.log(`  ${trade.side} ${trade.outcome} @ $${trade.price.toFixed(4)}`);
        console.log(`  Result: ${result.success ? '✅ Success' : '❌ Failed'}`);
        if (result.orderId) console.log(`  OrderId: ${result.orderId}`);
        if (result.errorMsg) console.log(`  Error: ${result.errorMsg}`);

        // Send to Discord
        discord?.notify(
          [
            `**Copy Trade ${result.success ? '✅ SUCCESS' : '❌ FAIL'}**`,
            `Trader: \`${trade.traderName || trade.traderAddress}\``,
            `Market: ${trade.marketSlug || 'unknown'}`,
            `${trade.side} ${trade.outcome || 'unknown'} @ $${trade.price.toFixed(4)} (size: $${trade.size.toFixed(2)})`,
            result.orderId ? `OrderId: \`${result.orderId}\`` : null,
            result.errorMsg ? `Error: ${result.errorMsg}` : null,
          ].filter(Boolean).join('\n')
        );
      },
      onError: (error) => {
        console.error('\n❌ Copy Trading Error:', error.message);
        
        // Send to Discord
        discord?.notify(`❌ **Copy Trading Error**\n${error.message}`);
      },
    });

    return subscription;
  }

  // Reconnection state
  let subscription: any = null;
  let reconnecting = false;
  let reconnectInterval: NodeJS.Timeout | null = null;

  // Graceful shutdown handler
  const shutdown = async () => {
    console.log('\n\n🛑 Shutting down...');
    
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
    }
    
    subscription?.stop();
    smartMoneyService.disconnect();
    realtimeService.disconnect();
    
    console.log('✅ Cleanup complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    // Initial connection
    await connectRealtime();
    subscription = await startAutoCopy();

    console.log(`\n✅ Auto copy trading started!`);
    console.log(`   Tracking ${subscription.targetAddresses.length} wallets`);
    console.log(`   Target addresses:`);
    subscription.targetAddresses.slice(0, 5).forEach((addr, i) => {
      console.log(`     ${i + 1}. ${addr.slice(0, 10)}...${addr.slice(-6)}`);
    });
    if (subscription.targetAddresses.length > 5) {
      console.log(`     ... and ${subscription.targetAddresses.length - 5} more`);
    }

    // Send detailed startup notification to Discord
    if (discord) {
      const startupMessage = [
        '🤖 **Copy Trading Bot Started**',
        '',
        `**Mode:** ${DRY_RUN ? '🧪 DRY RUN (Testing Mode)' : '💰 LIVE TRADING'}`,
        `**Our Wallet:** \`${ourAddress}\``,
        '',
        '**Configuration:**',
        `• Size Scale: ${SIZE_SCALE * 100}%`,
        `• Max Per Trade: $${MAX_SIZE_PER_TRADE}`,
        `• Min Trade Size: $${MIN_TRADE_SIZE}`,
        `• Max Slippage: ${MAX_SLIPPAGE * 100}%`,
        `• Order Type: ${ORDER_TYPE}`,
        `• Reconnect Interval: ${RECONNECT_MS / 1000}s`,
        '',
        `**Tracking ${subscription.targetAddresses.length} Target${subscription.targetAddresses.length > 1 ? 's' : ''}:**`,
        ...subscription.targetAddresses.map((addr, i) => 
          `${i + 1}. \`${addr}\``
        ),
        '',
        '⏳ **Status:** Listening for trades...',
      ].join('\n');
      
      discord.notify(startupMessage);
    }

    console.log('\n⏳ Listening for trades... (Press Ctrl+C to stop)\n');

    // Setup automatic reconnection every 60 seconds
    reconnectInterval = setInterval(async () => {
      if (reconnecting) return; // Skip if already reconnecting
      
      reconnecting = true;
      try {
        console.log('\n[Reconnect] Reconnecting WebSocket...');
        
        // Stop current subscription
        subscription?.stop();
        
        // Disconnect services
        smartMoneyService.disconnect();
        realtimeService.disconnect();
        
        // Small delay to ensure clean disconnect
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Reconnect
        await connectRealtime();
        subscription = await startAutoCopy();
        
        console.log('  ✅ Reconnection successful\n');
        
      } catch (error: any) {
        console.error('  ❌ Reconnection failed:', error.message);
      
        await shutdown();
      } finally {
        reconnecting = false;
      }
    }, RECONNECT_MS);



  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    discord?.notify(`❌ **Fatal Error**\n${error.message}`);
    
    smartMoneyService.disconnect();
    realtimeService.disconnect();
    process.exit(1);
  }
}

main().catch(console.error);

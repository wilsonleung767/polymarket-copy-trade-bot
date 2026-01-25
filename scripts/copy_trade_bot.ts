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
import path from 'node:path';
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
import {
  createJsonlFileLogger,
  extractErrorDetails,
  setupConsoleErrorInterceptor,
} from '../logger.js';

// ============================================================
// CONFIGURATION - Edit these values to customize your bot
// ============================================================

// Trading Mode
const DRY_RUN = false;                    // true = test mode (no real trades), false = live trading

// Trade Sizing
const SIZE_SCALE = 0.99;                     // Percentage of their trade size to copy (1 = 100%, 0.1 = 10%)
const MAX_SIZE_PER_TRADE = 2;            // Maximum USDC per trade (safety limit)
const MIN_TRADE_SIZE = 1;                // Minimum trade size to copy (filter small trades)

// Risk Management
const MAX_SLIPPAGE = 0.06;                // Maximum slippage tolerance (0.03 = 3%)
const ORDER_TYPE = 'FOK';                 // FOK = Fill or Kill, FAK = Fill and Kill

// Target Wallets - Add addresses to follow
const TARGET_ADDRESSES = [
  "0x6297b93ea37ff92a57fd636410f3b71ebf74517e",
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
  const logFile = process.env.LOG_FILE || path.join('logs', 'copy_trade_bot.jsonl');
  const fileLog = createJsonlFileLogger(logFile);

  // Setup console.error interceptor to redact CLOB Client errors
  setupConsoleErrorInterceptor(fileLog);

  console.log('='.repeat(60));
  console.log('🤖 Auto Copy Trading - Smart Money Follower');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? '🧪 DRY RUN (No real trades)' : '💰 LIVE TRADING'}`);
  console.log(`Following: ${TARGET_ADDRESSES.length} wallet(s)`);
  console.log(`Size Scale: ${SIZE_SCALE * 100}%`);
  console.log(`Max per trade: $${MAX_SIZE_PER_TRADE}`);
  console.log(`Min trade size: $${MIN_TRADE_SIZE}`);
  console.log('='.repeat(60));

  // Check for private key
  const privateKey = process.env.PRIVATE_KEY || process.env.POLY_PRIVATE_KEY;
  if (!privateKey) {
    fileLog.write('fatal_error', {
      message: 'PRIVATE_KEY or POLY_PRIVATE_KEY not found in .env',
    });
    console.error('❌ PRIVATE_KEY or POLY_PRIVATE_KEY not found in .env');
    process.exit(1);
  }

  // Initialize Discord notifier (optional)
  const webhookUrl = process.env.TEST_DISCORD_WEBHOOK_URL;
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

  fileLog.write('startup', {
    mode: DRY_RUN ? 'dry_run' : 'live',
    ourWallet: ourAddress,
    sizeScale: SIZE_SCALE,
    maxSizePerTrade: MAX_SIZE_PER_TRADE,
    minTradeSize: MIN_TRADE_SIZE,
    maxSlippage: MAX_SLIPPAGE,
    orderType: ORDER_TYPE,
    targets: TARGET_ADDRESSES,
  });

  try {
    // Connect WebSocket
    console.log('\n[WebSocket] Connecting...');
    realtimeService.connect();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      realtimeService.once('connected', () => {
        clearTimeout(timeout);
        console.log('  ✅ WebSocket connected');
        fileLog.write('ws_connected');
        resolve();
      });
    });

    // Start auto copy trading
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
        // Extract error details from various possible shapes
        const errorDetails = extractErrorDetails(result);
        
        fileLog.write('trade_result', {
          traderName: trade.traderName || null,
          traderAddress: trade.traderAddress,
          marketSlug: trade.marketSlug,
          side: trade.side,
          outcome: trade.outcome,
          price: trade.price,
          size: trade.size,
          success: result.success,
          orderId: result.orderId || null,
          errorMsg: errorDetails.errorMsg,
          errorStatus: errorDetails.errorStatus,
          errorSource: errorDetails.errorSource,
        });

        console.log('\n📈 Copy Trade Executed:');
        console.log(`  Trader: ${trade.traderName || trade.traderAddress.slice(0, 10)}...`);
        console.log(`  Market: ${trade.marketSlug}`);
        
        // Color code outcome: green for YES, red for NO
        const outcomeColor = trade.outcome === 'YES' ? '\x1b[32m' : '\x1b[31m'; // green : red
        const resetColor = '\x1b[0m';
        console.log(`  ${trade.side} ${outcomeColor}${trade.outcome}${resetColor} @ $${trade.price.toFixed(4)}`);
        console.log(`  Result: ${result.success ? '✅ Success' : '❌ Failed'}`);
        if (result.orderId) console.log(`  OrderId: ${result.orderId}`);
        if (errorDetails.errorMsg) {
          console.log(`  Error: ${errorDetails.errorMsg}`);
          if (errorDetails.errorStatus) {
            console.log(`  Status: ${errorDetails.errorStatus}`);
          }
        }

        // Send to Discord with tick emoji for YES, cross for NO
        const outcomeEmoji = trade?.outcome?.toLowerCase() =='yes' || trade?.outcome?.toLowerCase() == "up" ? '✅' : '❌';
        discord?.notify(
          [
            `**Copy Trade ${result.success ? '✅ SUCCESS' : '❌ FAIL'}**`,
            `Trader: \`${trade.traderName || trade.traderAddress}\``,
            `Market: ${trade.marketSlug || 'unknown'}`,
            `${trade.side} ${trade.outcome || 'unknown'} ${outcomeEmoji} @ $${trade.price.toFixed(4)} (size: $${trade.size.toFixed(2)})`,
            result.orderId ? `OrderId: \`${result.orderId}\`` : null,
            errorDetails.errorMsg ? `Error: ${errorDetails.errorMsg}` : null,
          ].filter(Boolean).join('\n')
        );
      },
      onError: (error) => {
        fileLog.write('copytrading_error', {
          message: error.message,
          stack: error.stack || null,
          cause: (error as any).cause ? String((error as any).cause) : null,
        });
        console.error('\n❌ Copy Trading Error:', error.message);
        
        // Send to Discord
        discord?.notify(`❌ **Copy Trading Error**\n${error.message}`);
      },
    });

    fileLog.write('copytrading_started', {
      tracking: subscription.targetAddresses.length,
    });

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

  } catch (error: any) {
    fileLog.write('fatal_error', {
      message: error?.message || String(error),
    });
    console.error('\n❌ Error:', error.message);
    discord?.notify(`❌ **Fatal Error**\n${error.message}`);
    
    smartMoneyService.disconnect();
    realtimeService.disconnect();
    process.exit(1);
  }
}

main().catch(console.error);

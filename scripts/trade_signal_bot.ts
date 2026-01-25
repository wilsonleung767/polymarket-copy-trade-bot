/**
 * Real-Time Trade Activity Tracker
 *
 * Monitors a target wallet address for trading activity using WebSocket
 * and broadcasts trade signals to Discord via webhook.
 *
 * Features:
 * - Real-time WebSocket monitoring (< 100ms latency)
 * - Auto-reconnect on disconnect
 * - Market metadata resolution (name, link)
 * - Discord webhook notifications with rich formatting
 * - Transaction deduplication
 * - UTC+8 timezone for timestamps
 *
 * Configuration:
 * - TARGET_ADDRESSES: Array of wallet addresses to track (hardcoded in script)
 * 
 * Environment Variables:
 * - DISCORD_WEBHOOK_URL: Discord webhook URL (required)
 *
 * Run: pnpm exec tsx scripts/trade_signal.ts
 */

import 'dotenv/config';
import {
  RealtimeServiceV2,
  GammaApiClient,
  DataApiClient,
  RateLimiter,
  createUnifiedCache,
  type ActivityTrade,
} from '@catalyst-team/poly-sdk';

// ============================================================
// CONFIGURATION
// ============================================================

// Target wallet addresses to track (add/remove addresses as needed)
const TARGET_ADDRESSES = [
  "0x6297b93ea37ff92a57fd636410f3b71ebf74517e",
];

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Transaction deduplication - keep last 2000 tx hashes
const MAX_SEEN_TX = 2000;
const seenTransactions = new Set<string>();

// Market metadata cache (slug -> question)
const marketCache = new Map<string, string>();

// Trader profile cache (address -> { userName, profileUrl })
interface TraderProfile {
  userName?: string;
  profileUrl?: string;
}
const traderProfileCache = new Map<string, TraderProfile>();

// ============================================================
// VALIDATION
// ============================================================

// Normalize and validate target addresses
const targetSet = new Set<string>();
for (const addr of TARGET_ADDRESSES) {
  const normalized = addr.toLowerCase().trim();
  
  // Basic validation: must start with 0x and be 42 chars
  if (!normalized.match(/^0x[0-9a-f]{40}$/)) {
    console.error(`❌ Invalid address format: ${addr}`);
    process.exit(1);
  }
  
  targetSet.add(normalized);
}

if (targetSet.size === 0) {
  console.error('❌ No valid target addresses configured');
  console.error('   Update TARGET_ADDRESSES in scripts/trade_signal.ts');
  process.exit(1);
}

if (!DISCORD_WEBHOOK_URL) {
  console.error('❌ DISCORD_WEBHOOK_URL not found in .env');
  console.error('   Add: DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...');
  process.exit(1);
}

// ============================================================
// DISCORD WEBHOOK NOTIFIER
// ============================================================

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
  url?: string;
  author?: {
    name: string;
    url?: string;
    icon_url?: string;
  };
}

function createDiscordWebhookNotifier(webhookUrl: string) {
  let queue = Promise.resolve();

  async function post(payload: { content?: string; embeds?: DiscordEmbed[] }) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Discord webhook failed: ${res.status} ${text}`);
    }
  }

  return {
    notify(content: string) {
      queue = queue.then(() => post({ content })).catch((e) => {
        console.error('[Discord Error]', e?.message || e);
      });
    },
    notifyEmbed(embed: DiscordEmbed) {
      queue = queue.then(() => post({ embeds: [embed] })).catch((e) => {
        console.error('[Discord Error]', e?.message || e);
      });
    },
  };
}

// ============================================================
// TIME FORMATTING (UTC+8)
// ============================================================

function formatTimeUTC8(timestamp: number): string {
  const date = new Date(timestamp);
  
  // Format: YYYY-MM-DD HH:mm:ss (UTC+8)
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';

  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

// ============================================================
// TRADER PROFILE RESOLVER
// ============================================================

async function resolveTraderProfile(
  dataApi: DataApiClient,
  address: string
): Promise<TraderProfile> {
  const normalized = address.toLowerCase();
  
  // Check cache first
  if (traderProfileCache.has(normalized)) {
    return traderProfileCache.get(normalized)!;
  }

  // Fetch from API
  try {
    const result = await dataApi.fetchLeaderboard({ 
      user: normalized, 
      limit: 1 
    });
    
    if (result.entries.length > 0) {
      const entry = result.entries[0];
      const userName = entry.userName;
      
      const profile: TraderProfile = {
        userName,
        profileUrl: userName ? `https://polymarket.com/@${userName}` : undefined,
      };
      
      traderProfileCache.set(normalized, profile);
      return profile;
    }
  } catch (error) {
    console.error(`[Trader Profile] Failed to fetch ${normalized}:`, error);
  }

  // Cache negative result (no username)
  const fallback: TraderProfile = {};
  traderProfileCache.set(normalized, fallback);
  return fallback;
}

// ============================================================
// MARKET METADATA RESOLVER
// ============================================================

async function resolveMarketName(
  gamma: GammaApiClient,
  marketSlug: string,
  eventSlug?: string
): Promise<{ name: string; link: string }> {
  // Construct proper URL: https://polymarket.com/event/{eventSlug}/{marketSlug}
  // If no eventSlug, fallback to: https://polymarket.com/event/{marketSlug}
  const link = eventSlug 
    ? `https://polymarket.com/event/${eventSlug}/${marketSlug}`
    : `https://polymarket.com/event/${marketSlug}`;

  // Check cache first
  if (marketCache.has(marketSlug)) {
    return {
      name: marketCache.get(marketSlug)!,
      link,
    };
  }

  // Fetch from API
  try {
    const market = await gamma.getMarketBySlug(marketSlug);
    if (market?.question) {
      marketCache.set(marketSlug, market.question);
      return {
        name: market.question,
        link,
      };
    }
  } catch (error) {
    console.error(`[Market Resolver] Failed to fetch ${marketSlug}:`, error);
  }

  // Fallback to slug
  return {
    name: marketSlug,
    link,
  };
}

// ============================================================
// TRANSACTION DEDUPLICATION
// ============================================================

function isSeenTransaction(txHash: string): boolean {
  if (seenTransactions.has(txHash)) {
    return true;
  }

  // Add to seen set
  seenTransactions.add(txHash);

  // Maintain max size (LRU-ish: delete oldest when full)
  if (seenTransactions.size > MAX_SEEN_TX) {
    const firstItem = seenTransactions.values().next().value;
    seenTransactions.delete(firstItem ?? "");
  }

  return false;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('='.repeat(60));
  console.log('📊 Real-Time Trade Activity Tracker');
  console.log('='.repeat(60));
  console.log(`Target Addresses: ${targetSet.size}`);
  
  // Show first 3 addresses (shortened)
  const displayAddresses = Array.from(targetSet).slice(0, 3);
  displayAddresses.forEach(addr => {
    console.log(`  - ${addr.slice(0, 10)}...${addr.slice(-8)}`);
  });
  if (targetSet.size > 3) {
    console.log(`  ... and ${targetSet.size - 3} more`);
  }
  
  console.log(`Timezone: UTC+8 (Asia/Shanghai)`);
  console.log('='.repeat(60));

  // Initialize Discord notifier
  const discord = createDiscordWebhookNotifier(DISCORD_WEBHOOK_URL ??'');

  // Initialize SDK clients
  console.log('\n[Init] Initializing SDK clients...');
  const cache = createUnifiedCache();
  const rateLimiter = new RateLimiter();
  const gamma = new GammaApiClient(rateLimiter, cache);
  const dataApi = new DataApiClient(rateLimiter, cache);
  const realtime = new RealtimeServiceV2({
    autoReconnect: true,
    pingInterval: 5000,
    debug: false,
  });

  console.log('  ✅ SDK clients initialized');

  // Prefetch trader profiles in background (non-blocking)
  console.log('\n[Init] Prefetching trader profiles...');
  const prefetchPromises = Array.from(targetSet).map(addr => 
    resolveTraderProfile(dataApi, addr).catch(err => {
      console.error(`  ⚠️  Failed to prefetch profile for ${addr.slice(0, 10)}...`, err.message);
    })
  );
  
  // Don't await - let it run in background
  Promise.all(prefetchPromises).then(() => {
    console.log('  ✅ Trader profiles prefetched');
  });

  // Track active subscription
  let activeSubscription: { unsubscribe: () => void } | null = null;

  // Subscribe to activity on connect
  const subscribeToActivity = () => {
    console.log('[WebSocket] Subscribing to activity stream...');

    // Clean up old subscription if exists
    if (activeSubscription) {
      activeSubscription.unsubscribe();
      activeSubscription = null;
    }

    // Subscribe to all trading activity
    activeSubscription = realtime.subscribeAllActivity({
      onTrade: async (trade: ActivityTrade) => {
        // Filter by target addresses
        const traderAddress = trade.trader?.address?.toLowerCase();
        if (!traderAddress || !targetSet.has(traderAddress)) {
          return;
        }
    
        // Deduplicate by transaction hash
        if (isSeenTransaction(trade.transactionHash)) {
          return;
        }

        // Log trade with colored outcome (green for YES, red for NO)
        const outcomeColor = trade.outcome === 'YES' ? '\x1b[32m' : '\x1b[31m'; // green : red
        const resetColor = '\x1b[0m';
        console.log(`\n📈 Trade detected: ${trade.side} ${outcomeColor}${trade.outcome}${resetColor} @ $${trade.price.toFixed(4)}`);

        // Resolve market metadata
        const { name, link } = await resolveMarketName(gamma, trade.marketSlug, trade.eventSlug);
        
        // Resolve trader profile
        const traderProfile = await resolveTraderProfile(dataApi, traderAddress);

        // Calculate USDC amount
        const usdcAmount = trade.size * trade.price;

        // Format timestamp (UTC+8)
        const time = formatTimeUTC8(trade.timestamp);

        // Determine color and emoji based on action
        // BUY = Green (#00ff00), SELL = Red (#ff0000)
        const isBuy = trade.side === 'BUY';
        const color = isBuy ? 0x00ff00 : 0xff0000;
        const actionText = isBuy ? 'BUY' : 'SELL';
        
        // Add tick emoji for YES, cross for NO
        const outcomeEmoji = trade.outcome.toLowerCase() =='yes' || trade.outcome.toLowerCase() == "up" ? '✅' : '❌';
        
        // Build Discord embed with rich formatting
        const embed: DiscordEmbed = {
          title: `${actionText} ${trade.outcome}${outcomeEmoji} `,
          url: link,
          color: color,
          author: traderProfile.userName && traderProfile.profileUrl
            ? {
                name: `👤 ${traderProfile.userName}`,
                url: traderProfile.profileUrl,
              }
            : {
                name: `👤 ${traderAddress.slice(0, 10)}...${traderAddress.slice(-8)}`,
              },
          fields: [
            {
              name: '📊 Market',
              value: `[${name}](${link})`,
              inline: false,
            },
            {
              name: '💰 Amount',
              value: `$${usdcAmount.toFixed(2)}`,
              inline: true,
            },
            {
              name: '📈 Price',
              value: `$${trade.price.toFixed(4)}`,
              inline: true,
            },
            {
              name: '📦 Size',
              value: `${trade.size.toFixed(2)} shares`,
              inline: true,
            },
            {
              name: '⏰ Time',
              value: `${time} (UTC+8)`,
              inline: false,
            },
            {
              name: '🔗 Transaction',
              value: `[\`${trade.transactionHash.slice(0, 10)}...${trade.transactionHash.slice(-8)}\`](https://polygonscan.com/tx/${trade.transactionHash})`,
              inline: false,
            },
          ],
          timestamp: new Date(trade.timestamp).toISOString(),
        };

        // Send to Discord
        discord.notifyEmbed(embed);

        console.log('  ✅ Notification sent to Discord');
      },
      onError: (error: Error) => {
        console.error('\n❌ Activity Stream Error:', error.message);
      },
    });

    console.log('  ✅ Subscribed to activity stream');
  };

  // Handle WebSocket connection events
  realtime.on('connected', () => {
    console.log('\n[WebSocket] Connected');
    subscribeToActivity();
  });

  realtime.on('disconnected', () => {
    console.log('\n[WebSocket] Disconnected');
    if (activeSubscription) {
      activeSubscription = null;
    }
  });

  // Connect to WebSocket
  console.log('\n[WebSocket] Connecting...');
  realtime.connect();

  // Wait for connection
  await new Promise<void>((resolve) => {
    realtime.once('connected', resolve);
    setTimeout(() => {
      if (!realtime.isConnected()) {
        console.error('❌ Connection timeout');
        process.exit(1);
      }
    }, 10000);
  });

  // Send startup notification
  // Build monitoring list with trader names
  const monitoringList = await Promise.all(
    Array.from(targetSet).map(async (addr) => {
      const profile = await resolveTraderProfile(dataApi, addr);
      if (profile.userName && profile.profileUrl) {
        return `[${profile.userName}](${profile.profileUrl}) - \`${addr.slice(0, 10)}...${addr.slice(-8)}\``;
      }
      return `\`${addr.slice(0, 10)}...${addr.slice(-8)}\``;
    })
  );

  const startupEmbed: DiscordEmbed = {
    title: '🤖 Trade Tracker Started',
    color: 0x00d9ff, // Cyan/blue color
    fields: [
      {
        name: '👁️ Monitoring',
        value: monitoringList.join('\n'),
        inline: false,
      },
      {
        name: '🌏 Timezone',
        value: 'UTC+8 (Asia/Shanghai)',
        inline: true,
      },
      {
        name: '📡 Status',
        value: '✅ Listening for trades...',
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
  };

  discord.notifyEmbed(startupEmbed);

  console.log('\n✅ Trade tracker is running!');
  console.log('   Listening for trades... (Press Ctrl+C to stop)\n');

  // Graceful shutdown with guard against multiple calls
  let shuttingDown = false;
  const shutdown = async () => {
    // Prevent multiple shutdown calls
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.log('\n\n🛑 Shutting down...');

    if (activeSubscription) {
      activeSubscription.unsubscribe();
    }

    realtime.disconnect();

    const shutdownEmbed: DiscordEmbed = {
      title: '🛑 Trade Tracker Stopped',
      color: 0xff6b6b, // Red color
      timestamp: new Date().toISOString(),
    };

    discord.notifyEmbed(shutdownEmbed);

    console.log('✅ Cleanup complete');
    
    // Give Discord webhook time to send before exiting
    await new Promise(resolve => setTimeout(resolve, 1000));
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});

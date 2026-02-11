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
 * - TARGET_ADDRESSES: Array of wallet addresses to track (hardcoded in script, fallback mode)
 * 
 * Environment Variables:
 * - DISCORD_WEBHOOK_URL: Discord webhook URL (required for fallback/legacy mode)
 * - BROADCAST_NODES_JSON: JSON array for multi-node routing (optional)
 *     Format: [{"name": "NodeA", "webhookEnvKey": "DISCORD_WEBHOOK_NODE_A", "targets": ["0x..."]}]
 * - DISCORD_WEBHOOK_NODE_*: Individual webhook URLs referenced by nodes
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
  "0x594edb9112f526fa6a80b8f858a6379c8a2c1c11",
];
const betThreshold = 5
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const BROADCAST_NODES_JSON = process.env.BROADCAST_NODES_JSON;

// ============================================================
// BROADCAST NODE CONFIGURATION
// ============================================================

interface BroadcastNode {
  name: string;
  webhookEnvKey: string;
  targets: string[];
}

interface DiscordNotifier {
  notify(content: string): void;
  notifyEmbed(embed: DiscordEmbed): void;
}

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
// VALIDATION & ROUTING SETUP
// ============================================================

// Parse and validate broadcast nodes configuration
let broadcastNodes: BroadcastNode[] = [];
const addressToNotifier = new Map<string, DiscordNotifier>();
const allNotifiers: DiscordNotifier[] = [];
let useLegacyMode = false;

function normalizeAddress(addr: string): string | null {
  const normalized = addr.toLowerCase().trim();
  
  // Basic validation: must start with 0x and be 42 chars
  if (!normalized.match(/^0x[0-9a-f]{40}$/)) {
    return null;
  }
  
  return normalized;
}

if (BROADCAST_NODES_JSON) {
  // Multi-node mode: parse JSON configuration
  try {
    const parsed = JSON.parse(BROADCAST_NODES_JSON);
    
    if (!Array.isArray(parsed)) {
      console.error('❌ BROADCAST_NODES_JSON must be an array');
      process.exit(1);
    }
    
    broadcastNodes = parsed;
    
    // Validate and build routing map
    const addressRegistry = new Map<string, string>(); // address -> node name (for duplicate detection)
    
    for (const node of broadcastNodes) {
      // Validate node structure
      if (!node.name || !node.webhookEnvKey || !Array.isArray(node.targets)) {
        console.error(`❌ Invalid node config: ${JSON.stringify(node)}`);
        console.error('   Required: {name, webhookEnvKey, targets}');
        process.exit(1);
      }
      
      // Resolve webhook URL from env
      const webhookUrl = process.env[node.webhookEnvKey];
      if (!webhookUrl) {
        console.error(`❌ Webhook env var not found: ${node.webhookEnvKey}`);
        console.error(`   Add to .env: ${node.webhookEnvKey}=https://discord.com/api/webhooks/...`);
        process.exit(1);
      }
      
      // Create notifier for this node
      const notifier = createDiscordWebhookNotifier(webhookUrl);
      allNotifiers.push(notifier);
      
      // Normalize and validate target addresses
      for (const addr of node.targets) {
        const normalized = normalizeAddress(addr);
        
        if (!normalized) {
          console.error(`❌ Invalid address format in node "${node.name}": ${addr}`);
          process.exit(1);
        }
        
        // Enforce 1-to-1 mapping: check for duplicate addresses across nodes
        if (addressRegistry.has(normalized)) {
          console.error(`❌ Duplicate address detected: ${addr}`);
          console.error(`   Already assigned to node "${addressRegistry.get(normalized)}"`);
          console.error(`   Cannot assign to node "${node.name}" (1-to-1 mapping enforced)`);
          process.exit(1);
        }
        
        // Register address -> notifier mapping
        addressRegistry.set(normalized, node.name);
        addressToNotifier.set(normalized, notifier);
      }
    }
    
    if (addressToNotifier.size === 0) {
      console.error('❌ No valid target addresses found in BROADCAST_NODES_JSON');
      console.error('   Add at least one target address to a node');
      process.exit(1);
    }
    
    console.log(`✅ Multi-node mode: ${broadcastNodes.length} nodes, ${addressToNotifier.size} unique addresses`);
    
  } catch (error) {
    console.error('❌ Failed to parse BROADCAST_NODES_JSON:', error);
    console.error('   Expected format: [{"name":"NodeA","webhookEnvKey":"DISCORD_WEBHOOK_NODE_A","targets":["0x..."]}]');
    process.exit(1);
  }
} else {
  // Legacy mode: use TARGET_ADDRESSES + DISCORD_WEBHOOK_URL
  useLegacyMode = true;
  
  if (!DISCORD_WEBHOOK_URL) {
    console.error('❌ DISCORD_WEBHOOK_URL not found in .env');
    console.error('   Add: DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...');
    console.error('   Or configure BROADCAST_NODES_JSON for multi-node mode');
    process.exit(1);
  }
  
  // Create single notifier for legacy mode
  const legacyNotifier = createDiscordWebhookNotifier(DISCORD_WEBHOOK_URL);
  allNotifiers.push(legacyNotifier);
  
  // Normalize and validate target addresses
  for (const addr of TARGET_ADDRESSES) {
    const normalized = normalizeAddress(addr);
    
    if (!normalized) {
      console.error(`❌ Invalid address format: ${addr}`);
      process.exit(1);
    }
    
    addressToNotifier.set(normalized, legacyNotifier);
  }
  
  if (addressToNotifier.size === 0) {
    console.error('❌ No valid target addresses configured');
    console.error('   Update TARGET_ADDRESSES in scripts/trade_signal.ts');
    process.exit(1);
  }
  
  console.log(`✅ Legacy mode: ${addressToNotifier.size} addresses -> single webhook`);
}

// Get all monitored addresses
const targetSet = new Set(addressToNotifier.keys());

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
  console.log(`Broadcast Mode: ${useLegacyMode ? 'Legacy (single webhook)' : 'Multi-node'}`);
  
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

        // Bet threshold
        const isExceedBetThreshold =  (usdcAmount > betThreshold) ? true  : false
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

        // Send to Discord via address-based routing
        const notifier = addressToNotifier.get(traderAddress);
        if (isExceedBetThreshold && notifier) {
          notifier.notifyEmbed(embed);
          console.log('  ✅ Notification sent to Discord');
        } else {
          console.error(`  ⚠️  No notifier found for address ${traderAddress}`);
        }
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
      {
        name: '🔊 Mode',
        value: useLegacyMode ? 'Legacy (1 webhook)' : `Multi-node (${broadcastNodes.length} nodes)`,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
  };

  // Broadcast startup message to all webhooks
  allNotifiers.forEach(notifier => notifier.notifyEmbed(startupEmbed));

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

    // Broadcast shutdown message to all webhooks
    allNotifiers.forEach(notifier => notifier.notifyEmbed(shutdownEmbed));

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

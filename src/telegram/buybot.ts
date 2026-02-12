/**
 * VOID Telegram Buy Bot — Solana Edition
 * 
 * Monitors the Raydium CLMM VOID/SOL pool for swap events.
 * Posts buy notifications to Telegram with VOID ranks and custom images.
 * 
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx VOID_MINT=xxx POOL_ID=xxx npx tsx src/telegram/buybot.ts
 */

import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import {
    Connection,
    PublicKey,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
    getAssociatedTokenAddress,
    getAccount,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getVoidRank, getRankImageUrl, getBuyEmojis } from "./ranks.js";

// ────────────────────────────────────────────
// Config
// ────────────────────────────────────────────
function env(key: string, fallback?: string): string {
    const v = process.env[key] ?? fallback;
    if (!v) throw new Error(`Missing env var: ${key}`);
    return v;
}

const TELEGRAM_BOT_TOKEN = env("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = env("TELEGRAM_CHAT_ID");
const RPC_URL = env("RPC_URL", "https://api.mainnet-beta.solana.com");
const RPC_WS_URL = env("RPC_WS_URL", RPC_URL.replace("https://", "wss://"));
const VOID_MINT = new PublicKey(env("VOID_MINT"));
// Track Raydium Pool for burn logic, but poll Mint for buys
const POOL_ID = new PublicKey(env("POOL_ID"));
const METEORA_POOL_W_VOID = new PublicKey("6rE8Ej3aae9QBukLYWFvzDAYmRgsygpKK1LbqLjHJGcL");
const METEORA_POOL_P_VOID = new PublicKey("5jW3M4defHZgCAt27FQU7upeELu5yWroiax9nmd2Bv62");

const POOLS = [POOL_ID, METEORA_POOL_W_VOID, METEORA_POOL_P_VOID];

const VOID_DECIMALS = 9;
const VOID_TOTAL_SUPPLY = 100_000_000;

// Minimum buy thresholds in USD
const MIN_BUY_USD = Number(env("MIN_BUY_USD", "25"));
const MIN_ARB_USD = Number(env("MIN_ARB_USD", "25")); // Updated to 25 as per user request
const ARB_BALANCE_THRESHOLD = Number(env("ARB_BALANCE_THRESHOLD", "500"));

// Burn animation/image URL
const BURN_IMAGE_URL = env("BURN_IMAGE_URL", "https://voidsolana.com/burn.jpg");
const ARB_IMAGE_URL = env("ARB_IMAGE_URL", "https://voidsolana.com/arbitrage.jpg");

const CHART_URL = env("CHART_URL", "https://dexscreener.com/solana");
const WEBSITE_URL = "https://voidsolana.com";

// ────────────────────────────────────────────
// Init
// ────────────────────────────────────────────
const connection = new Connection(RPC_URL, {
    wsEndpoint: RPC_WS_URL,
    commitment: "confirmed",
});

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const log = (msg: string) => console.log(`[${new Date().toISOString()}] [BUYBOT] ${msg}`);

// ────────────────────────────────────────────
// Message Queue (rate-limit TG API)
// ────────────────────────────────────────────
interface QueuedMessage {
    photo: string;
    caption: string;
    pin?: boolean;
}

const messageQueue: QueuedMessage[] = [];
let isSending = false;

function enqueue(msg: QueuedMessage) {
    messageQueue.push(msg);
    processQueue();
}

async function processQueue() {
    if (isSending || messageQueue.length === 0) return;
    isSending = true;

    const msg = messageQueue.shift()!;
    try {
        const sent = await bot.sendPhoto(TELEGRAM_CHAT_ID, msg.photo, {
            caption: msg.caption,
            parse_mode: "HTML",
            disable_notification: msg.pin,
        });
        if (msg.pin) {
            await bot.pinChatMessage(TELEGRAM_CHAT_ID, sent.message_id, {
                disable_notification: true,
            });
        }
        log("Message sent successfully");
    } catch (err) {
        log(`Failed to send photo: ${err}. Falling back to text...`);
        try {
            const sent = await bot.sendMessage(TELEGRAM_CHAT_ID, msg.caption, {
                parse_mode: "HTML",
                disable_notification: msg.pin,
                disable_web_page_preview: true,
            });
            if (msg.pin) {
                await bot.pinChatMessage(TELEGRAM_CHAT_ID, sent.message_id, {
                    disable_notification: true,
                });
            }
        } catch (err2) {
            log(`Failed to send fallback text: ${err2}`);
        }
    }

    setTimeout(() => {
        isSending = false;
        processQueue();
    }, 2000);
}

// ────────────────────────────────────────────
// Price Fetching (DexScreener — free, no key)
// ────────────────────────────────────────────
let cachedPrice: { usd: number; solPrice: number; ts: number } | null = null;

async function getVoidPrice(): Promise<{ usd: number; solPrice: number } | null> {
    // Cache for 30 seconds
    if (cachedPrice && Date.now() - cachedPrice.ts < 30_000) {
        return { usd: cachedPrice.usd, solPrice: cachedPrice.solPrice };
    }

    try {
        const resp = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${VOID_MINT.toBase58()}`
        );
        const data = await resp.json() as any;
        const pair = data.pairs?.[0]; // Best pair (highest liquidity)
        if (!pair?.priceUsd) return null;

        const usd = parseFloat(pair.priceUsd);
        const solPrice = parseFloat(pair.priceNative || "0");
        cachedPrice = { usd, solPrice, ts: Date.now() };
        return { usd, solPrice };
    } catch (err) {
        log(`Price fetch error: ${err}`);
        return null;
    }
}

// ────────────────────────────────────────────
// Token Balance Lookup
// ────────────────────────────────────────────
async function getVoidBalance(owner: PublicKey): Promise<number> {
    try {
        const ata = await getAssociatedTokenAddress(VOID_MINT, owner, true, TOKEN_PROGRAM_ID);
        const acct = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
        return Number(acct.amount) / 10 ** VOID_DECIMALS;
    } catch {
        return 0;
    }
}

async function getCurrentSupply(): Promise<number> {
    try {
        const info = await connection.getParsedAccountInfo(VOID_MINT);
        const data = (info.value?.data as any)?.parsed?.info;
        return data ? Number(data.supply) / 10 ** VOID_DECIMALS : VOID_TOTAL_SUPPLY;
    } catch {
        return VOID_TOTAL_SUPPLY;
    }
}

// ────────────────────────────────────────────
// Transaction Dedup
// ────────────────────────────────────────────
const processedTxs = new Set<string>();
const MAX_PROCESSED = 2000;

function markProcessed(sig: string): boolean {
    if (processedTxs.has(sig)) return false;
    if (processedTxs.size >= MAX_PROCESSED) {
        const first = processedTxs.values().next().value;
        if (first) processedTxs.delete(first);
    }
    processedTxs.add(sig);
    return true;
}

// ────────────────────────────────────────────
// Swap Detection via Transaction Polling
// ────────────────────────────────────────────
// We poll recent transactions on the pool account to detect swaps.
// This is more reliable than WebSocket log subscriptions for Raydium CLMM.

let lastSignature: string | undefined;

async function pollForSwaps() {
    try {
        // Direct fetch to bypass web3.js internal retries
        const limit = 10;
        const untilParam = lastSignature ? `&until=${lastSignature}` : "";
        // Fixed: Do not blindly append '/' as it breaks URLs with query parameters (Helius API keys)
        const url = RPC_URL;

        const body = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getSignaturesForAddress",
            params: [
                VOID_MINT.toBase58(),
                { limit, ...(lastSignature ? { until: lastSignature } : {}) }
            ]
        });

        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body
        });

        if (resp.status === 429) {
            throw new Error("429 Too Many Requests");
        }

        const data = await resp.json() as any;
        if (data.error) throw new Error(JSON.stringify(data.error));

        const sigs = data.result;
        if (!sigs || sigs.length === 0) return;

        // Update cursor to newest signature
        lastSignature = sigs[0].signature;

        // Process in chronological order (oldest first)
        for (const sigInfo of sigs.reverse()) {
            if (!markProcessed(sigInfo.signature)) continue;
            if (sigInfo.err) continue; // skip failed txs

            try {
                await processTransaction(sigInfo.signature);
            } catch (err) {
                log(`Error processing tx ${sigInfo.signature}: ${err}`);
            }
        }
    } catch (err) {
        throw err; // Re-throw to be caught by pollLoop
    }
}

async function processTransaction(signature: string) {
    const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
    });

    if (!tx || !tx.meta) return;

    // ────────────────────────────────────────────
    // Data Extraction
    // ────────────────────────────────────────────
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];
    const innerInstructions = tx.meta.innerInstructions || [];
    const logs = tx.meta.logMessages || [];

    const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
    const DEAD_ADDRESS = "11111111111111111111111111111111";
    // Wallet that performs burns/LP management (Ignore buys from this wallet)
    const HELPER_WALLET = "CEJnLWLEzRGSaeaoWKVSnhA4QD4mZaRY9sQbz4NNfyLz";

    // ────────────────────────────────────────────
    // 1. BURN DETECTION
    // ────────────────────────────────────────────

    // A. Check for "Burn" instructions in logs
    const isBurnLog = logs.some(l => l.includes("Instruction: Burn") || l.includes("BurnChecked"));

    // B. Check for transfers to Incinerator/Dead address
    const deadTransfers = postBalances.filter(b =>
        (b.owner === INCINERATOR || b.owner === DEAD_ADDRESS) &&
        b.mint === VOID_MINT.toBase58()
    );

    // If explicit transfer to dead address found
    for (const trans of deadTransfers) {
        const pre = preBalances.find(p => p.accountIndex === trans.accountIndex);
        const gain = (trans.uiTokenAmount?.uiAmount ?? 0) - (pre?.uiTokenAmount?.uiAmount ?? 0);
        if (gain > 0) {
            // Find who sent it (whose balance decreased by this amount)
            let burner = "Unknown";
            const sender = preBalances.find(p => {
                const post = postBalances.find(b => b.accountIndex === p.accountIndex);
                const loss = (p.uiTokenAmount?.uiAmount ?? 0) - (post?.uiTokenAmount?.uiAmount ?? 0);
                return p.mint === VOID_MINT.toBase58() && Math.abs(loss - gain) < 0.001;
            });
            if (sender && sender.owner) burner = sender.owner;

            await handleBurn(signature, burner, gain);
            return;
        }
    }

    // C. Logic for proper SPL Burn (supply decrease)
    // If it's a burn instruction, someone's balance decreased and NO ONE else's increased (except maybe zero address if transfer-burn).
    if (isBurnLog) {
        for (const preBal of preBalances) {
            if (preBal.mint !== VOID_MINT.toBase58()) continue;

            const postBal = postBalances.find(b => b.accountIndex === preBal.accountIndex);
            const loss = (preBal.uiTokenAmount?.uiAmount ?? 0) - (postBal?.uiTokenAmount?.uiAmount ?? 0);

            if (loss > 0) {
                // Check if pool gained (Sell)
                const poolBal = postBalances.find(b => b.owner === POOL_ID.toBase58());
                const poolPre = preBalances.find(p => p.owner === POOL_ID.toBase58());
                const poolGain = (poolBal?.uiTokenAmount?.uiAmount ?? 0) - (poolPre?.uiTokenAmount?.uiAmount ?? 0);

                // If pool didn't gain this amount (allow small tolerance)
                if (poolGain < loss * 0.9) {
                    await handleBurn(signature, preBal.owner!, loss);
                    return;
                }
            }
        }
    }

    // ────────────────────────────────────────────
    // 2. BUY DETECTION
    // ────────────────────────────────────────────

    // A BUY occurs if a Pool Account (LP) loses VOID tokens.
    // This catches normal buys AND "atomic" arbitrage (buy/sell in same TX).
    let totalBought = 0;
    let buyer = tx.transaction.message.accountKeys[0].pubkey.toBase58();
    let maxBuyerBalance = 0;
    let isTrade = false;

    for (const postBal of postBalances) {
        if (postBal.mint !== VOID_MINT.toBase58()) continue;
        const preBal = preBalances.find(p => p.accountIndex === postBal.accountIndex);
        const delta = (postBal.uiTokenAmount?.uiAmount ?? 0) - (preBal?.uiTokenAmount?.uiAmount ?? 0);

        if (delta < 0) {
            // If the account that lost VOID is a known Pool or a Program PDA (likely a liquidity vault)
            const isPool = POOLS.some(p => p.toBase58() === postBal.owner) ||
                postBal.owner?.length! < 44; // PDAs or Programs
            if (isPool) {
                totalBought += Math.abs(delta);
                isTrade = true;
            }
        } else if (delta > 0) {
            // Use the largest receiver as the "Buyer" for the notification
            if (postBal.uiTokenAmount.uiAmount! > maxBuyerBalance) {
                maxBuyerBalance = postBal.uiTokenAmount.uiAmount!;
                buyer = postBal.owner || buyer;
            }
        }
    }

    if (isTrade && totalBought > 0.01 && buyer !== HELPER_WALLET) {
        // Double check it's not a sell (pool gained VOID)
        // If Pool gained VOID, that's handled as a sell (not posted)
        // We only post if the NET Pool change is negative for VOID.
        await handleBuy(signature, buyer, totalBought, maxBuyerBalance);
    }
}

// ────────────────────────────────────────────
// Handle Burn Event
// ────────────────────────────────────────────
async function handleBurn(signature: string, burner: string, amount: number) {
    const price = await getVoidPrice();
    if (!price) return;

    const usdValue = amount * price.usd;
    const currentSupply = await getCurrentSupply();
    const totalBurned = VOID_TOTAL_SUPPLY - currentSupply; // This might be slightly stale if we just burned

    const caption = `🔥🔥🔥 <b>VOID BURNED</b> 🔥🔥🔥

🗑️ <b>${formatNumber(amount)} VOID</b> ($${usdValue.toFixed(2)}) sent to the Void.

🔥 Total Burned: ${formatNumber(totalBurned)}
🟣 Supply: ${formatNumber(currentSupply)}

<a href="${CHART_URL}">Chart</a> | <a href="https://solscan.io/tx/${signature}">TX</a>`;

    log(`Burn detected: ${amount} VOID by ${burner}`);
    enqueue({
        photo: BURN_IMAGE_URL,
        caption,
        pin: true // Pin burns!
    });
}

// ────────────────────────────────────────────
// Handle Buy Event
// ────────────────────────────────────────────
async function handleBuy(
    signature: string,
    buyerAddress: string,
    voidAmount: number,
    currentBalance: number
) {
    const price = await getVoidPrice();
    if (!price) {
        log(`Skipping buy — price unavailable`);
        return;
    }

    const usdValue = voidAmount * price.usd;
    const isArbitrage = currentBalance < ARB_BALANCE_THRESHOLD;

    // Apply minimum thresholds
    if (isArbitrage && usdValue < MIN_ARB_USD) {
        log(`Skipping arb: $${usdValue.toFixed(2)}`);
        return;
    }
    if (!isArbitrage && usdValue < MIN_BUY_USD) {
        log(`Skipping small buy: $${usdValue.toFixed(2)}`);
        return;
    }

    // Calculate supply metrics
    const currentSupply = await getCurrentSupply();
    const totalBurned = VOID_TOTAL_SUPPLY - currentSupply;
    const percentBurned = (totalBurned / VOID_TOTAL_SUPPLY) * 100;
    const marketCap = price.usd * currentSupply;

    // Determine rank and image
    const rank = getVoidRank(currentBalance);
    const imageUrl = isArbitrage ? ARB_IMAGE_URL : getRankImageUrl(rank);
    const emojis = getBuyEmojis(usdValue, isArbitrage);

    const txLink = `https://solscan.io/tx/${signature}`;
    const addressLink = `https://solscan.io/account/${buyerAddress}`;

    const caption = `${emojis}
💸 Bought ${formatNumber(voidAmount)} VOID ($${usdValue.toFixed(2)})${!isArbitrage ? ` (<a href="${addressLink}">View</a>)` : ""}
🟣 VOID Price: $${price.usd < 0.01 ? price.usd.toPrecision(4) : price.usd.toFixed(5)}
💰 Market Cap: $${formatMarketCap(marketCap)}
🔥 Total Burned: ${formatNumber(totalBurned)} VOID
🔥 Burned: ${percentBurned.toFixed(3)}%
📈 <a href="${CHART_URL}">Chart</a> | <a href="${txLink}">TX</a> | <a href="${WEBSITE_URL}">Web</a>${!isArbitrage ? `
⚖️ Balance: ${formatNumber(currentBalance)} VOID
🛡️ Rank: ${rank}` : "\n⚠️ Arbitrage Transaction"}`;

    log(`Buy detected: ${formatNumber(voidAmount)} VOID ($${usdValue.toFixed(2)}) by ${buyerAddress.slice(0, 8)}...`);

    enqueue({
        photo: imageUrl,
        caption,
    });
}

// ────────────────────────────────────────────
// Formatting Helpers
// ────────────────────────────────────────────
function formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
    return n.toFixed(2);
}

function formatMarketCap(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toFixed(0);
}

// ────────────────────────────────────────────
// Bot Commands
// ────────────────────────────────────────────
bot.onText(/\/price/, async (msg) => {
    const price = await getVoidPrice();
    if (!price) {
        bot.sendMessage(msg.chat.id, "⚠️ Price unavailable");
        return;
    }
    const supply = await getCurrentSupply();
    const burned = VOID_TOTAL_SUPPLY - supply;
    const mc = price.usd * supply;

    bot.sendMessage(msg.chat.id,
        `🟣 <b>VOID Price</b>\n\n` +
        `💵 $${price.usd < 0.01 ? price.usd.toPrecision(4) : price.usd.toFixed(6)}\n` +
        `💰 Market Cap: $${formatMarketCap(mc)}\n` +
        `🔥 Burned: ${formatNumber(burned)} (${((burned / VOID_TOTAL_SUPPLY) * 100).toFixed(2)}%)\n` +
        `📊 Supply: ${formatNumber(supply)}`,
        { parse_mode: "HTML" }
    );
});

bot.onText(/\/rank/, async (msg) => {
    bot.sendMessage(msg.chat.id,
        `🛡️ <b>VOID Rank System</b>\n\n` +
        `Your rank is based on your VOID balance after buying.\n` +
        `From 🧑‍🌾 <b>VOID Peasant</b> (1+ VOID) to 👑 <b>VOID Ultimate</b> (2M+ VOID).\n\n` +
        `There are 70 unique ranks, each with a custom character.\n` +
        `Buy VOID to ascend through the ranks!\n\n` +
        `📈 <a href="${CHART_URL}">Buy on DexScreener</a>`,
        { parse_mode: "HTML", disable_web_page_preview: true }
    );
});

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `🟣 <b>Welcome to The Void</b>\n\n` +
        `The Black Hole of Solana — deflationary, autonomous, unstoppable.\n\n` +
        `Commands:\n` +
        `/price — Current VOID price & stats\n` +
        `/rank — VOID Rank system info\n\n` +
        `🌐 <a href="${WEBSITE_URL}">Website</a> | ` +
        `📈 <a href="${CHART_URL}">Chart</a> | ` +
        `🐦 <a href="https://x.com/VOIDINSOL">Twitter</a>`,
        { parse_mode: "HTML", disable_web_page_preview: true }
    );
});

// ────────────────────────────────────────────
// Main Loop
// ────────────────────────────────────────────
const POLL_INTERVAL = Number(env("BUYBOT_POLL_MS", "30000")); // 30 seconds default (Safe for public RPC)

export async function startBuyBot() {
    log("Starting VOID Telegram Buy Bot...");
    log(`Mint: ${VOID_MINT.toBase58()}`);
    log(`Tracking ${POOLS.length} pools locally, polling Mint broadly.`);
    log(`Chat: ${TELEGRAM_CHAT_ID}`);
    log(`Poll interval (Target): ${POLL_INTERVAL}ms`);
    log(`Min buy: $${MIN_BUY_USD} | Min arb: $${MIN_ARB_USD}`);

    // Set initial cursor to latest signature on Mint
    const initial = await connection.getSignaturesForAddress(VOID_MINT, { limit: 1 }, "confirmed");
    if (initial.length > 0) {
        lastSignature = initial[0].signature;
        log(`Broad Signature Start: ${lastSignature.slice(0, 16)}...`);
    }

    // Start polling loop with dynamic backoff
    pollLoop();

    log("Buy bot running ✓");
}

let backoff = 1000;
const BASE_INTERVAL = Number(env("BUYBOT_POLL_MS", "30000")); // 30 seconds default

async function pollLoop() {
    const start = Date.now();
    try {
        await pollForSwaps();
        backoff = 1000; // reset backoff on success
    } catch (err: any) {
        log(`Polling error: ${err.message || err}`);
        if (String(err).includes("429")) {
            backoff = Math.min(backoff * 2, 60000); // Exponential backoff max 1 min
            log(`Rate limited (429). Backing off for ${backoff}ms...`);
        }
    }

    const elapsed = Date.now() - start;
    const delay = Math.max(0, BASE_INTERVAL - elapsed) + (backoff > 1000 ? backoff : 0);
    setTimeout(pollLoop, delay);
}

// Override setInterval logic
// setInterval(pollForSwaps, POLL_INTERVAL); is removed

// Only auto-run if this file is executed directly
if (import.meta.url.includes("buybot.ts") || import.meta.url.includes("buybot.js")) {
    startBuyBot().catch((err: any) => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
}

import "dotenv/config";
import { claimVoid } from "./burn.js";
import { claimFees } from "./fees.js";
import { loadState, POLL_INTERVAL_MS, wallet, connection } from "./config.js";

const log = (msg: string) => console.log(`[${new Date().toISOString()}] [MAIN] ${msg}`);

const dryRun = process.argv.includes("--dry-run");

async function tick() {
    try {
        if (dryRun) log("=== DRY RUN MODE ===");

        // Log wallet info
        const balance = await connection.getBalance(wallet.publicKey);
        log(`Wallet: ${wallet.publicKey.toBase58()} | SOL: ${(balance / 1e9).toFixed(4)}`);

        // Check state
        const state = loadState();
        const now = Math.floor(Date.now() / 1000);
        const nextBurnIn = state.nextVoidTime - now;

        if (nextBurnIn > 0) {
            log(`Next burn in ${(nextBurnIn / 3600).toFixed(1)}h | Total burned: ${state.totalBurned}`);
        } else {
            log("Burn is due! Executing...");
        }

        // Try to burn
        const burned = await claimVoid(dryRun);

        // Collect fees (on every cycle, independent of burn)
        if (!dryRun) {
            // await claimFees(dryRun); 
            // Disabled to reduce "Remove Liquidity" spam on DexScreener.
            // Run "npx tsx collect-fees.ts" manually if needed.
        }

        if (burned) {
            log("━━━ Burn cycle completed successfully ━━━");
        }
    } catch (err) {
        log(`Error in tick: ${err}`);
        // Don't crash — just log and wait for next poll
    }
}

export async function startBurnBot() {
    log("╔══════════════════════════════════════╗");
    log("║     THE VOID — Solana Burn Bot       ║");
    log("╚══════════════════════════════════════╝");
    log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
    log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
    log("");

    // Run immediately on start
    await tick();

    // Then poll on interval
    setInterval(tick, POLL_INTERVAL_MS);
}

// Only auto-run if this file is executed directly
if (import.meta.url.endsWith("index.ts") || import.meta.url.endsWith("index.js")) {
    startBurnBot().catch((err) => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
}

import { startBurnBot } from "./bot/index.js";
import { startBuyBot } from "./telegram/buybot.js";

console.log("🌌 THE VOID — Starting Unified Service...");

// Run both bots concurrently
async function startAll() {
    try {
        // We run both but don't await them as they are perpetual loops
        startBurnBot().catch(err => console.error("[BURN BOT ERROR]", err));
        startBuyBot().catch(err => console.error("[BUY BOT ERROR]", err));

        console.log("🚀 Both bots initialized and running in the background.");
    } catch (err: any) {
        console.error("Failed to start bots:", err);
        process.exit(1);
    }
}

startAll();

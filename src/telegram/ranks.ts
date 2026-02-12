/**
 * VOID Rank System 
 * 
 * Ranks are based on total VOID balance after purchase.
 * Thresholds are in whole tokens (not raw lamports).
 * See getRankImageUrl() for custom images per rank.
 */

export interface VoidRank {
    name: string;
    threshold: number; // minimum VOID balance (whole tokens)
}

// Ordered from highest to lowest
export const VOID_RANKS: VoidRank[] = [
    { name: "VOID Ultimate", threshold: 2_000_000 },
    { name: "VOID Omega", threshold: 1_500_000 },
    { name: "VOID Absolute", threshold: 1_000_000 },
    { name: "VOID Singularity", threshold: 900_000 },
    { name: "VOID Omnipotence", threshold: 850_000 },
    { name: "VOID Eternity", threshold: 800_000 },
    { name: "VOID Apotheosis", threshold: 750_000 },
    { name: "VOID Divine", threshold: 650_000 },
    { name: "VOID Celestial", threshold: 600_000 },
    { name: "VOID Exalted", threshold: 550_000 },
    { name: "VOID Transcendent", threshold: 500_000 },
    { name: "VOID Majesty", threshold: 450_000 },
    { name: "VOID Sovereign", threshold: 400_000 },
    { name: "VOID Monarch", threshold: 350_000 },
    { name: "VOID Admiral", threshold: 300_000 },
    { name: "VOID Warden", threshold: 250_000 },
    { name: "VOID Harbinger", threshold: 225_000 },
    { name: "VOID Evoker", threshold: 200_000 },
    { name: "VOID Emperor", threshold: 175_000 },
    { name: "VOID Guardian", threshold: 150_000 },
    { name: "VOID Berserker", threshold: 135_000 },
    { name: "VOID Juggernaut", threshold: 120_000 },
    { name: "VOID Lord", threshold: 100_000 },
    { name: "VOID Alchemist", threshold: 90_000 },
    { name: "VOID Clairvoyant", threshold: 85_000 },
    { name: "VOID Conjurer", threshold: 80_000 },
    { name: "VOID Archdruid", threshold: 70_000 },
    { name: "VOID Sorcerer", threshold: 50_000 },
    { name: "VOID Shaman", threshold: 45_000 },
    { name: "VOID Sage", threshold: 40_000 },
    { name: "VOID Warrior", threshold: 35_000 },
    { name: "VOID Enchanter", threshold: 30_000 },
    { name: "VOID Seer", threshold: 27_500 },
    { name: "VOID Necromancer", threshold: 25_000 },
    { name: "VOID Summoner", threshold: 22_500 },
    { name: "VOID Master", threshold: 20_000 },
    { name: "VOID Disciple", threshold: 15_000 },
    { name: "VOID Acolyte", threshold: 12_500 },
    { name: "VOID Expert", threshold: 10_000 },
    { name: "VOID Apprentice", threshold: 7_500 },
    { name: "VOID Rookie", threshold: 5_000 },
    { name: "VOID Learner", threshold: 2_500 },
    { name: "VOID Initiate", threshold: 1_000 },
    { name: "VOID Peasant", threshold: 1 },
];

/**
 * Get the VOID rank for a given balance (in whole tokens, not raw)
 */
export function getVoidRank(balance: number): string {
    for (const rank of VOID_RANKS) {
        if (balance >= rank.threshold) {
            return rank.name;
        }
    }
    return "VOID Peasant";
}

/**
 * Get the rank image URL. For now uses voidsolana.com hosted images.
 * Replace with actual hosted image URLs once uploaded.
 */
export function getRankImageUrl(rankName: string): string {
    // Correctly map ranks to images: rank2.png (Lowest/Peasant) to rank45.png (Highest/Ultimate)
    const rankIndex = VOID_RANKS.findIndex(r => r.name === rankName);

    if (rankIndex === -1) return "https://voidsolana.com/ranks/rank2.png"; // Fallback to Peasant

    // Calculate image number:
    // VOID_RANKS[0] = Highest -> Needs rank45.png
    // VOID_RANKS[Last] = Lowest -> Needs rank2.png

    const totalRanks = VOID_RANKS.length;
    // Normalized 0 to 1 value where 1 is highest rank
    const normalized = 1 - (rankIndex / (totalRanks - 1));

    // Map to 2..45 range
    // Range is 43 steps (45 - 2)
    const imageNum = 2 + Math.round(normalized * 43);

    return `https://voidsolana.com/ranks/rank${imageNum}.png`;
}

/**
 * Get emoji string for buy messages based on USD value
 */
export function getBuyEmojis(usdValue: number, isArbitrage: boolean): string {
    const pairCount = Math.min(Math.floor(usdValue / (isArbitrage ? 100 : 50)), 48);
    if (pairCount === 0) return isArbitrage ? "🤖🔩" : "🟣🔥";
    return isArbitrage ? "🤖🔩".repeat(pairCount) : "🟣🔥".repeat(pairCount);
}

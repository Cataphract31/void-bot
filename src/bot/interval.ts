import { TOTAL_SUPPLY, BENCHMARK_SUPPLY } from "./config.js";

/**
 * Calculate the burn interval based on how much supply has been burned.
 * Mirrors the original Entropy.sol logic:
 *
 *   Base:            12 hours
 *   ≥  5% burned:  + 6h  → 18h
 *   ≥ 10% burned:  + 6h  → 24h
 *   ≥ 15% burned:  + 6h  → 30h
 *   ≥ 30% burned:  + 6h  → 36h
 *   ≥ 50% burned:  +12h  → 48h
 */
export function calculateInterval(currentSupply: bigint): number {
    const burned = TOTAL_SUPPLY - currentSupply;
    const totalEntropy = burned / BENCHMARK_SUPPLY; // how many 1% chunks burned

    let intervalHours = 12;

    if (totalEntropy >= 5n) intervalHours += 6;   // 18h
    if (totalEntropy >= 10n) intervalHours += 6;  // 24h
    if (totalEntropy >= 15n) intervalHours += 6;  // 30h
    if (totalEntropy >= 30n) intervalHours += 6;  // 36h
    if (totalEntropy >= 50n) intervalHours += 12; // 48h

    return intervalHours * 3600; // return seconds
}

/**
 * Get human-readable interval string
 */
export function formatInterval(seconds: number): string {
    const hours = seconds / 3600;
    return `${hours}h`;
}

/**
 * Calculate what percentage of supply has been burned
 */
export function burnedPercentage(currentSupply: bigint): string {
    const burned = TOTAL_SUPPLY - currentSupply;
    const pct = Number(burned * 10000n / TOTAL_SUPPLY) / 100;
    return `${pct.toFixed(2)}%`;
}

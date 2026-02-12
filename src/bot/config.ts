import "dotenv/config";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// ── helpers ─────────────────────────────────────────────
function env(key: string, fallback?: string): string {
    const v = process.env[key] ?? fallback;
    if (!v) throw new Error(`Missing env var: ${key}`);
    return v;
}

function loadKeypair(): Keypair {
    // 1. Try to load from Environment Variable (Recommended for Production/Render)
    const privateKeyStr = process.env.PRIVATE_KEY;
    if (privateKeyStr) {
        try {
            // Handle JSON array format [1, 2, 3...]
            if (privateKeyStr.startsWith("[")) {
                return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(privateKeyStr)));
            }
            // Handle Base58 format (Standard Phantom/Solana string)
            return Keypair.fromSecretKey(Uint8Array.from(bs58.decode(privateKeyStr)));
        } catch (e) {
            throw new Error(`Failed to parse PRIVATE_KEY environment variable: ${e}`);
        }
    }

    // 2. Fallback to File (Local Development)
    const filePath = env("KEYPAIR_PATH", "./keypair.json");
    const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(ROOT, filePath);

    if (!fs.existsSync(resolved)) {
        throw new Error(`Private key not found! Set PRIVATE_KEY env var or create ${resolved}`);
    }

    const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ── exports ─────────────────────────────────────────────
export const RPC_URL = env("RPC_URL", "https://api.mainnet-beta.solana.com");
export const connection = new Connection(RPC_URL, "confirmed");
export const wallet = loadKeypair();

export const VOID_MINT = new PublicKey(env("VOID_MINT"));
export const POOL_ID = env("POOL_ID"); // Raydium CLMM pool ID string

export const POLL_INTERVAL_MS = Number(env("POLL_INTERVAL_MS", "1200000")); // 20 minutes

// Total supply at launch — 100M with 9 decimals
export const TOTAL_SUPPLY = 100_000_000n * 10n ** 9n;
// 1% of total supply — used as the benchmark unit for interval calculation
export const BENCHMARK_SUPPLY = TOTAL_SUPPLY / 100n;

// ── state persistence ───────────────────────────────────
export interface BotState {
    nextVoidTime: number; // unix timestamp (seconds) of next allowed burn
    totalBurned: string;  // cumulative VOID burned (as string for bigint serialization)
}

const STATE_PATH = path.resolve(ROOT, "state.json");

export function loadState(): BotState {
    if (fs.existsSync(STATE_PATH)) {
        return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
    }
    return { nextVoidTime: 0, totalBurned: "0" };
}

export function saveState(state: BotState): void {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

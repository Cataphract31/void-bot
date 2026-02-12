import {
    connection,
    wallet,
    VOID_MINT,
    POOL_ID,
    loadState,
    saveState,
    RPC_URL,
} from "./config.js";
import { calculateInterval, formatInterval, burnedPercentage } from "./interval.js";
import { Raydium, ApiV3PoolInfoConcentratedItem, ClmmKeys } from "@raydium-io/raydium-sdk-v2";
import {
    getAccount,
    getAssociatedTokenAddress,
    createBurnInstruction,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
    Transaction,
    sendAndConfirmTransaction,
    ComputeBudgetProgram,
} from "@solana/web3.js";
import BN from "bn.js";

const log = (msg: string) => console.log(`[${new Date().toISOString()}] [BURN] ${msg}`);

let raydiumInstance: Raydium | null = null;

async function getRaydium(): Promise<Raydium> {
    if (!raydiumInstance) {
        raydiumInstance = await Raydium.load({
            connection,
            owner: wallet,
            cluster: "mainnet",
        });
    }
    return raydiumInstance;
}

/**
 * Fetch the current VOID supply from the mint account
 */
async function getCurrentSupply(): Promise<bigint> {
    const mintInfo = await connection.getParsedAccountInfo(VOID_MINT);
    const data = (mintInfo.value?.data as any)?.parsed?.info;
    if (!data) throw new Error("Failed to fetch VOID mint info");
    return BigInt(data.supply);
}

/**
 * Main burn cycle:
 * 1. Check timer
 * 2. Remove 1% liquidity from Raydium CLMM position
 * 3. Burn the VOID received
 * 4. Update next_void_time with dynamic interval
 */
export async function claimVoid(dryRun = false): Promise<boolean> {
    const state = loadState();
    const now = Math.floor(Date.now() / 1000);

    // ── Check timer (CEI: check first) ──
    if (now < state.nextVoidTime) {
        const remaining = state.nextVoidTime - now;
        const hours = (remaining / 3600).toFixed(1);
        log(`Not yet — ${hours}h remaining until next burn`);
        return false;
    }

    // ── Calculate interval BEFORE any actions (CEI: effects before interactions) ──
    const currentSupply = await getCurrentSupply();
    const interval = calculateInterval(currentSupply);

    // Update state immediately (CEI pattern)
    state.nextVoidTime = now + interval;
    saveState(state);
    log(`Timer set: next burn in ${formatInterval(interval)} (supply burned: ${burnedPercentage(currentSupply)})`);

    if (dryRun) {
        log("[DRY RUN] Would remove 1% liquidity, burn VOID, keep SOL");
        return true;
    }

    try {
        // ── Load Raydium SDK and pool ──
        log("Loading Raydium CLMM pool...");
        const raydium = await getRaydium();

        const data = await raydium.api.fetchPoolById({ ids: POOL_ID });
        const poolInfo = data[0] as ApiV3PoolInfoConcentratedItem;
        if (!poolInfo) throw new Error(`Pool ${POOL_ID} not found`);

        // ── Get our position ──
        const allPositions = await raydium.clmm.getOwnerPositionInfo({
            programId: poolInfo.programId,
        });

        const position = allPositions.find(
            (p) => p.poolId.toBase58() === poolInfo.id
        );

        if (!position) {
            log("ERROR: No position found in this pool! Did you add liquidity?");
            return false;
        }

        if (position.liquidity.isZero()) {
            log("No liquidity remaining in position — nothing to burn");
            return false;
        }

        // ── Calculate 1% of position liquidity ──
        const onePercent = position.liquidity.div(new BN(100));
        if (onePercent.isZero()) {
            log("Position too small — 1% rounds to zero");
            return false;
        }

        log(`Removing 1% liquidity (${onePercent.toString()} / ${position.liquidity.toString()})...`);

        // Get VOID balance before removal
        const voidAta = await getAssociatedTokenAddress(
            VOID_MINT,
            wallet.publicKey,
            false,
            TOKEN_PROGRAM_ID
        );

        let voidBefore = 0n;
        try {
            const acct = await getAccount(connection, voidAta, "confirmed", TOKEN_PROGRAM_ID);
            voidBefore = acct.amount;
        } catch { /* ATA may not exist yet */ }

        // ── Remove 1% liquidity ──
        const { execute } = await raydium.clmm.decreaseLiquidity({
            poolInfo,
            ownerPosition: position,
            ownerInfo: {
                useSOLBalance: true,
                closePosition: false, // Keep position open for future burns
            },
            liquidity: onePercent,
            amountMinA: new BN(0),
            amountMinB: new BN(0),
            txVersion: 0, // legacy tx
            computeBudgetConfig: {
                units: 400000,
                microLamports: 50000,
            },
        });

        const { txId } = await execute({ sendAndConfirm: true });
        log(`Remove liquidity TX: ${txId}`);

        // ── Burn VOID tokens received ──
        await new Promise((r) => setTimeout(r, 3000)); // wait for chain

        const voidAccount = await getAccount(
            connection,
            voidAta,
            "confirmed",
            TOKEN_PROGRAM_ID
        );
        const voidReceived = voidAccount.amount - voidBefore;

        if (voidReceived > 0n) {
            log(`Burning ${voidReceived} VOID...`);
            const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: 50_000,
            });
            const burnIx = createBurnInstruction(
                voidAta,
                VOID_MINT,
                wallet.publicKey,
                voidReceived,
                [],
                TOKEN_PROGRAM_ID
            );

            const burnTx = new Transaction().add(priorityFeeIx, burnIx);
            const burnSig = await sendAndConfirmTransaction(connection, burnTx, [wallet]);
            log(`Burned ${voidReceived} VOID — TX: ${burnSig}`);

            state.totalBurned = (BigInt(state.totalBurned) + voidReceived).toString();
            saveState(state);
        } else {
            log("No VOID received from removal (position may be out of range on VOID side)");
        }

        // SOL stays in wallet for reinvestment
        const solBalance = await connection.getBalance(wallet.publicKey);
        log(`Wallet SOL balance: ${(solBalance / 1e9).toFixed(4)} SOL`);

        const updatedSupply = await getCurrentSupply();
        log(`Current VOID supply: ${updatedSupply.toString()} (burned: ${burnedPercentage(updatedSupply)})`);
        log("Burn cycle complete ✓");

        return true;
    } catch (err) {
        log(`ERROR during burn: ${err}`);
        state.nextVoidTime = now + 60; // retry in 1 minute
        saveState(state);
        throw err;
    }
}

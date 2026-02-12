import {
    connection,
    wallet,
    VOID_MINT,
    POOL_ID,
    RPC_URL,
} from "./config.js";
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
import { Raydium, ApiV3PoolInfoConcentratedItem } from "@raydium-io/raydium-sdk-v2";

const log = (msg: string) => console.log(`[${new Date().toISOString()}] [FEES] ${msg}`);

/**
 * Collect accrued trading fees from the Raydium CLMM position.
 * 
 * On Raydium CLMM, fees accrue separately (like Uni V3).
 * We decrease liquidity by 0 to trigger fee collection,
 * then burn any VOID received and keep SOL.
 */
export async function claimFees(dryRun = false): Promise<boolean> {
    try {
        log("Loading pool and position...");
        const raydium = await Raydium.load({
            connection,
            owner: wallet,
            cluster: "mainnet",
        });

        const data = await raydium.api.fetchPoolById({ ids: POOL_ID });
        const poolInfo = data[0] as ApiV3PoolInfoConcentratedItem;
        if (!poolInfo) throw new Error(`Pool ${POOL_ID} not found`);

        const allPositions = await raydium.clmm.getOwnerPositionInfo({
            programId: poolInfo.programId,
        });

        const position = allPositions.find(
            (p) => p.poolId.toBase58() === poolInfo.id
        );

        if (!position) {
            log("ERROR: Position not found!");
            return false;
        }

        // Check for pending fees/rewards
        // tokenFeeAmountA = VOID fees, tokenFeeAmountB = SOL fees
        const feeA = position.tokenFeesOwedA;
        const feeB = position.tokenFeesOwedB;

        log(`Pending fees — VOID: ${feeA.toString()}, SOL: ${feeB.toString()}`);

        if (feeA.isZero() && feeB.isZero()) {
            log("State says 0 fees, but forcing collection to check/update...");
            // return false; // REMOVED: Force collection because on-chain state might be stale
        }

        if (dryRun) {
            log("[DRY RUN] Would collect fees and burn VOID portion");
            return true;
        }

        // Get VOID balance before fee collection
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
        } catch { /* ATA may not exist */ }

        // Decrease by 0 liquidity to collect fees only
        const { execute } = await raydium.clmm.decreaseLiquidity({
            poolInfo,
            ownerPosition: position,
            ownerInfo: {
                useSOLBalance: true,
                closePosition: false,
            },
            liquidity: position.liquidity.muln(0), // 0 = fee collection only
            amountMinA: position.tokenFeesOwedA,
            amountMinB: position.tokenFeesOwedB,
            txVersion: 0,
            computeBudgetConfig: {
                units: 400000,
                microLamports: 50000,
            },
        });

        const { txId } = await execute({ sendAndConfirm: true });
        log(`Fee collection TX: ${txId}`);

        // Burn any VOID received from fees
        await new Promise((r) => setTimeout(r, 2000));

        const voidAccount = await getAccount(
            connection,
            voidAta,
            "confirmed",
            TOKEN_PROGRAM_ID
        );
        const voidReceived = voidAccount.amount - voidBefore;

        if (voidReceived > 0n) {
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
            const sig = await sendAndConfirmTransaction(connection, burnTx, [wallet]);
            log(`Burned ${voidReceived} VOID from fees — TX: ${sig}`);
        }

        log("Fee collection complete ✓");
        return true;
    } catch (err) {
        log(`ERROR during fee collection: ${err}`);
        throw err;
    }
}

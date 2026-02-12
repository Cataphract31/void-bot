# THE VOID — Solana

Deflationary DeFi protocol on Solana. Burns 1% of LP liquidity on a timer, reducing supply permanently while retaining SOL for ecosystem reinvestment.

## Architecture

```
┌──────────────┐     ┌───────────────────┐     ┌──────────────┐
│  Burn Bot    │────▶│  Meteora DLMM     │     │  VOID Token  │
│  (TypeScript)│     │  VOID/SOL Pool    │     │  SPL Token-  │
│              │────▶│                   │────▶│  2022 Mint   │
│  Every 12-48h│     │  Your LP position │     │  (burn)      │
└──────────────┘     └───────────────────┘     └──────────────┘
   dev wallet            concentrated              supply ↓
   holds position        liquidity
```

## Quick Start

### Prerequisites
- Node.js ≥ 18
- pnpm (`npm install -g pnpm`)
- Solana CLI (`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`)
- A Solana wallet with some SOL for transaction fees

### 1. Setup

```bash
# Clone this repo
cd void-solana

# Install dependencies
pnpm install

# Copy env template
cp .env.example .env
# Edit .env with your RPC URL and keypair path
```

### 2. Launch Token + Pool (Automated via Meteora Invent)

```bash
# Clone Meteora's CLI toolkit
git clone https://github.com/MeteoraAg/meteora-invent.git
cd meteora-invent && pnpm install && cd ..

# Copy your keypair to meteora-invent/
cp keypair.json meteora-invent/keypair.json

# Copy the config
cp dlmm_config.jsonc meteora-invent/studio/config/dlmm_config.jsonc

# EDIT the config first:
# 1. Set "positionOwner" and "feeOwner" to your wallet address
# 2. Set "initialPrice" based on desired MC and current SOL price
# 3. Put your logo at meteora-invent/data/image/void-logo.png
# 4. Update website/twitter URLs

# Create token + pool (one command)
cd meteora-invent
pnpm studio dlmm-create-pool

# Seed all tokens into the pool (single-sided, no SOL needed)
pnpm studio dlmm-seed-liquidity-lfg --baseMint <VOID_MINT_ADDRESS>
cd ..
```

After this completes:
- Note down the **VOID mint address** and **pool address** from the output
- Find your **position address** (the LP position NFT)
- Fill these into your `.env` file

### 3. Configure & Start the Burn Bot

```bash
# Fill in .env with addresses from step 2:
# VOID_MINT=<mint address>
# POOL_ADDRESS=<pool address>
# POSITION_ADDRESS=<position address>

# Test with dry run first
pnpm run bot:dry

# Start the bot for real
pnpm run bot
```

### 4. Production Deployment

For a VPS (e.g., a $5 DigitalOcean droplet):

```bash
# Install PM2 for process management
npm install -g pm2

# Start the bot with PM2
pm2 start "pnpm run bot" --name void-burn-bot

# Auto-restart on reboot
pm2 startup
pm2 save

# Monitor
pm2 logs void-burn-bot
```

## How It Works

### Burn Cycle (`claimVoid`)
1. Bot checks if `now >= nextVoidTime`
2. Calls Meteora `removeLiquidity` — removes **1%** of the LP position's liquidity
3. Receives VOID + SOL tokens from the removed liquidity
4. **Burns all VOID** via SPL Token burn instruction (supply decreases permanently)
5. **Keeps SOL** in dev wallet for reinvestment into side pools
6. Updates `nextVoidTime = now + dynamicInterval`

### Dynamic Interval Scaling
| Supply Burned | Interval |
|---|---|
| 0-4% | 12 hours |
| 5-9% | 18 hours |
| 10-14% | 24 hours |
| 15-29% | 30 hours |
| 30-49% | 36 hours |
| 50%+ | 48 hours |

### Fee Collection (`claimFees`)
- Runs on every cycle alongside the burn
- Collects accrued trading fees from the Meteora DLMM position
- VOID fees are burned, SOL fees stay in wallet

### CEI Pattern (Exploit Prevention)
The timer state (`nextVoidTime`) is updated **BEFORE** any chain interactions. This prevents the reentrancy attack that exploited the original EVM deployment, where the timer was set after external calls.

## File Structure

```
void-solana/
├── .env.example          # Environment variables template
├── dlmm_config.jsonc     # Meteora pool + token config (Invent CLI)
├── package.json
├── tsconfig.json
├── state.json            # Bot state (auto-generated, gitignored)
├── keypair.json          # Your wallet (gitignored!)
└── src/
    └── bot/
        ├── index.ts      # Main polling loop
        ├── burn.ts       # claimVoid — 1% LP removal + VOID burn
        ├── fees.ts       # claimFees — trading fee collection
        ├── interval.ts   # Dynamic interval calculator
        └── config.ts     # Env loading, state persistence
```

## Future: Decentralization Upgrade

When ready to make the protocol trustless:
1. Write an Anchor (Rust) program with PDA-owned position
2. Transfer LP position NFT from dev wallet → program PDA
3. Bot calls program instructions instead of Meteora directly
4. Anyone can run the bot or call instructions manually
5. Renounce program upgrade authority for full immutability

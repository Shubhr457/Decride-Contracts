# Decride Contracts

Smart contract workspace for the Decride decentralized ride-sharing platform.

## Architecture

```
contracts/
├── token/
│   └── RIDEToken.sol              – ERC-20 utility + governance token (1B RIDE, ERC20Votes)
├── oracle/
│   ├── IRideUsdOracle.sol         – Price feed interface (1e18 USD per RIDE)
│   └── ManualRideUsdOracle.sol    – Owner-governed feed for staging; replace with Chainlink in production
├── staking/
│   └── DriverStaking.sol          – Driver collateral ($100 USD minimum, oracle-priced)
├── ride/
│   └── RideEscrow.sol             – Ride lifecycle state machine (fee hard-capped at 10%)
├── reputation/
│   └── ReputationRegistry.sol     – On-chain participant ratings (1–5)
├── dispute/
│   └── DisputeResolution.sol      – Eligible arbitrator pool, pseudo-random jury, juror rewards
├── governance/
│   └── DAOGovernor.sol            – OZ Governor + Timelock (7d delay, 14d voting, 4% quorum)
├── vesting/
│   ├── DecrideVestingWallet.sol   – OZ VestingWallet wrapper with label
│   └── VestingWalletFactory.sol   – Factory for allocation buckets (team, investors, ecosystem)
└── interfaces/
    ├── IDriverStaking.sol
    └── IRideEscrow.sol
```

## Contract Development Phases

1. Project scaffold and Hardhat toolchain
2. RIDE ERC-20 governance token
3. Driver staking with USD-denominated collateral and oracle
4. Ride escrow lifecycle and settlement (10% fee cap)
5. Rider and driver reputation registry
6. Dispute resolution with eligible pool, deterministic jury, and juror rewards
7. DAO governance, vesting infrastructure, deployment scripts, and documentation

## Commands

```bash
npm install        # install dependencies
npm run build      # compile contracts
npm test           # run test suite
npm run coverage   # generate Istanbul coverage report
```

## Deployment

Local:

```bash
npx hardhat run scripts/deploy.js --network hardhat
```

Testnet (Polygon Amoy):

```bash
export POLYGON_AMOY_RPC_URL="https://polygon-amoy.g.alchemy.com/v2/<key>"
export DEPLOYER_PRIVATE_KEY="0x..."
export TREASURY_ADDRESS="0x..."
export MATCHER_ADDRESS="0x..."
npx hardhat run scripts/deploy.js --network amoy
```

Key environment variables (all have local defaults):

| Variable | Description | Default |
|---|---|---|
| `TREASURY_ADDRESS` | Receives initial RIDE and fees | deployer |
| `MATCHER_ADDRESS` | Off-chain matching service | deployer |
| `RIDE_USD_PRICE_E18` | Oracle initial price (1e18 = $1.00) | 1e17 ($0.10) |
| `MIN_DRIVER_STAKE_USD_E18` | USD minimum stake | 100e18 ($100) |
| `PLATFORM_FEE_BPS` | Platform commission ≤ 1000 | 1000 (10%) |
| `REQUEST_TIMEOUT_SEC` | Unmatched ride refund window | 900 (15 min) |
| `RIDE_TIMEOUT_SEC` | Stuck ride refund window | 7200 (2 h) |
| `UNSTAKE_COOLDOWN_SEC` | Driver unstake cooldown | 604800 (7 days) |
| `MIN_ARBITRATOR_STAKE` | RIDE to join arbitrator pool | 50 RIDE |
| `VOTING_PERIOD_SEC` | Dispute voting window | 172800 (48 h) |
| `JUROR_REWARD_PER_CASE` | RIDE rewards per resolved case | 5 RIDE |
| `TIMELOCK_MIN_DELAY_SEC` | Governor execution delay | 172800 (48 h) |

## Scope Boundary

On-chain: funds, ride status, participant authorization, ratings, staking positions, dispute votes, treasury fee routing, DAO proposals, vesting schedules.

Off-chain: GPS traces, pickup/dropoff coordinates, KYC documents, chat logs, raw evidence files. Contracts reference these by content hashes (`metadataHash`, `evidenceHash`).

## Important Notes

- **Platform fee hard cap:** `RideEscrow.MAX_PLATFORM_FEE_BPS = 1000` (10%) enforced at the contract level per SOW.
- **Dispute randomness:** `openCaseWithRandomJury` uses `block.prevrandao` (EIP-4399) seeded sampling. This is MVP-safe but not production-grade. Replace with Chainlink VRF before mainnet.
- **USD collateral:** `DriverStaking` derives the required RIDE stake from `ManualRideUsdOracle`. Price drops can deactivate drivers; they must top up their stake.
- **Governance ownership:** After deployment the Timelock owns all protocol contracts. Parameter changes require a DAO proposal (7-day voting delay + 14-day voting period + 48-hour execution delay).
- **Vesting:** Allocations are created via `VestingWalletFactory`; RIDE tokens must be transferred to each wallet address after creation.

## Audit and Coverage

SOW Phase 2 gate: >90% branch coverage. Run `npm run coverage` to measure.

SOW Phase 5 requirement: two independent smart contract audits before mainnet. Run Slither locally on every PR (`slither .`).

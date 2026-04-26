# Decride Contract Spec

## Phase Contracts

| Contract | Purpose |
|---|---|
| `RIDEToken` | ERC-20 utility and governance token (1B fixed supply). ERC20Votes, ERC20Permit, launch anti-whale transfer limit (2% cap, owner-configurable). |
| `ManualRideUsdOracle` | Owner-governed USD price feed for 1 RIDE (1e18 precision). Intended for development/staging; replace with Chainlink in production. |
| `DriverStaking` | Driver collateral staking. Minimum collateral is $100 USD at current oracle price. Cooldown-based withdrawal and authorized slash to treasury. |
| `RideEscrow` | Full ride lifecycle: Requested → Matched → Active → Completed / Disputed / Refunded / Cancelled. Platform fee hard-capped at 10% (1000 bps). Stuck-ride timeout recovery for Matched/Active states. |
| `ReputationRegistry` | Participant-only post-ride ratings (1–5). Average rating enforced as on-chain driver access threshold. |
| `DisputeResolution` | Eligible arbitrator pool with RIDE staking. Cases opened via pseudo-random jury draw (block.prevrandao, MVP) or admin-supplied jury. 48-hour voting window, juror rewards from reward reserve, loser/abstainer slashing by governance. |
| `DAOGovernor` | OpenZeppelin Governor + TimelockController. 7-day voting delay, 14-day voting period, 4% quorum threshold. |
| `DecrideVestingWallet` | OZ VestingWallet wrapper with a project-specific label for traceability. |
| `VestingWalletFactory` | Owner-only factory for creating labelled vesting wallets (team, investors, ecosystem, etc.). Callers fund wallets directly with RIDE after creation. |

## On-Chain Boundary

Contracts store funds, status, role authorization, votes, ratings, staking positions, and content hashes. GPS data, KYC files, route evidence, chats, and raw trip metadata remain off-chain, referenced by `bytes32 metadataHash` / `evidenceHash` fields.

## Oracle

`IRideUsdOracle.latestPrice()` returns the USD price of 1 RIDE with 1e18 precision.

| Value | Meaning |
|---|---|
| `1e18` (1 followed by 18 zeros) | 1 RIDE = $1.00 |
| `1e17` | 1 RIDE = $0.10 (default on local/staging) |

`DriverStaking.requiredRideStakeAmount()` = `minimumStakeUsdE18 * 1e18 / latestPrice()`.
If the RIDE price drops, drivers with insufficient stake lose their `isDriverActive` status and must top up.

## Platform Fee

`RideEscrow.MAX_PLATFORM_FEE_BPS = 1000` (10%). The `setPlatformFee` setter and constructor both enforce this hard cap. Any governance proposal attempting to raise the fee above 10% will revert.

## Dispute Randomness (MVP)

`openCaseWithRandomJury` uses `keccak256(block.prevrandao, block.number, address(this), rideId, caseId)` as entropy for Fisher–Yates without-replacement sampling from the eligible pool. This is pseudo-random and block-proposer-influenceable. **Replace with a Chainlink VRF subscription before mainnet.**

## Juror Rewards

The `rewardReserve` in `DisputeResolution` is funded via `fundRewardReserve()`. After a case executes, jurors who voted with the winning outcome share `jurorRewardPerCase` equally. If the reserve is insufficient, rewards are silently skipped — the reserve balance is public for monitoring.

## Deployment Order

1. Deploy `RIDEToken` → `treasury` receives 1B RIDE.
2. Deploy `ManualRideUsdOracle` → owner = deployer (transferred to timelock in step 13).
3. Deploy `DriverStaking` (pass oracle, treasury, USD minimum, cooldown).
4. Deploy `RideEscrow` (pass driverStaking, treasury, matcher, deployer as temp resolver, feeBps, requestTimeout, rideTimeout).
5. Deploy `DisputeResolution` (pass rideToken, rideEscrow, treasury, minArbitratorStake, votingPeriod, jurorRewardPerCase).
6. `rideEscrow.setDisputeResolver(disputeResolution)`.
7. Deploy `ReputationRegistry` (pass rideEscrow, minimumDriverAverage).
8. Deploy `VestingWalletFactory` (owner = deployer).
9. Deploy `TimelockController` (minDelay = 48h, no proposers yet, open executor, admin = deployer).
10. Deploy `DAOGovernor` (rideToken, timelock).
11. Grant `PROPOSER_ROLE` and `CANCELLER_ROLE` to governor on timelock. Revoke deployer admin role.
12. Exempt operational contracts from RIDE launch transfer limits: `rideEscrow`, `disputeResolution`, `driverStaking`, `vestingFactory`.
13. Transfer ownership of all protocol contracts to the timelock.

> After step 13 all parameter changes require a DAO governance proposal. Ensure at least one token holder has delegated RIDE voting power before completing step 13, otherwise the DAO cannot reach quorum to make changes.

## Vesting Flow

1. Governance (or deployer before ownership handoff) calls `VestingWalletFactory.createVesting(beneficiary, start, duration, label)`.
2. Factory emits `VestingCreated` and records the wallet address.
3. Caller transfers the allocation of RIDE tokens directly to the wallet address.
4. Beneficiary calls `wallet.release(rideTokenAddress)` after `start` to claim vested tokens.

## Coverage and Audit

Target: >90% branch coverage before mainnet deployment (SOW Phase 2 gate requirement).
Run `npm run coverage` to generate the Istanbul report.

Audits: two independent smart contract audit firms required per SOW Phase 5 before mainnet launch. SAST via Slither should be run on every PR.

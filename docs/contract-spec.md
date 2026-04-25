# Decride Contract Spec

## Phase Contracts

- `RIDEToken`: ERC-20 utility and governance token with ERC20Votes and launch transfer limits.
- `DriverStaking`: driver collateral staking, cooldown-based withdrawal, and slash permissions.
- `RideEscrow`: ride request, match, start, completion, dispute, refund, and fee settlement.
- `ReputationRegistry`: participant-only post-ride ratings for riders and drivers.
- `DisputeResolution`: RIDE-staked arbitrator jury voting with escrow settlement execution.
- `DAOGovernor`: OpenZeppelin Governor wired to a TimelockController and RIDE voting power.

## On-Chain Boundary

Contracts store funds, status, role authorization, votes, ratings, and hashes. GPS data, KYC files, route evidence, chats, and raw trip metadata stay off-chain and are referenced by hashes or external IDs.

## Deployment Notes

1. Deploy `RIDEToken`.
2. Deploy `DriverStaking`.
3. Deploy `RideEscrow` with a temporary dispute resolver.
4. Deploy `DisputeResolution`.
5. Set `RideEscrow` dispute resolver to `DisputeResolution`.
6. Deploy `ReputationRegistry`.
7. Deploy `TimelockController` and `DAOGovernor`.
8. Grant timelock proposer and canceller roles to the governor.
9. Transfer ownership of protocol contracts to the timelock after operational addresses are verified.

For RIDE payments, exempt operational contracts such as escrow and dispute resolution from launch transfer limits before high-value testnet/mainnet flows.

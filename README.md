# Decride Contracts

Smart contract workspace for the Decride decentralized ride-sharing platform.

## Contract Development Phases

1. Project scaffold and Hardhat toolchain
2. RIDE ERC-20 governance token
3. Driver staking and collateral management
4. Ride escrow lifecycle and settlement
5. Rider and driver reputation registry
6. Dispute resolution and arbitrator staking
7. DAO governance, deployment scripts, and documentation

## Commands

```bash
npm install
npm run build
npm test
```

## Scope Boundary

The contracts keep trust-critical state on-chain: funds, ride status, participant authorization, ratings, staking, dispute outcomes, treasury fee routing, and DAO-controlled parameters.

Sensitive or high-volume data stays off-chain: GPS traces, pickup/dropoff coordinates, KYC documents, chat logs, and raw evidence files. Contracts should reference those artifacts by identifiers or hashes only.

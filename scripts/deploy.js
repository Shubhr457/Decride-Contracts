/**
 * Decride full protocol deployment script.
 *
 * Deployment order (mirrors docs/contract-spec.md):
 *   1. RIDEToken
 *   2. ManualRideUsdOracle
 *   3. DriverStaking  (wired to oracle)
 *   4. RideEscrow     (temporary dispute resolver = deployer; patched in step 6)
 *   5. DisputeResolution
 *   6. Patch RideEscrow dispute resolver → DisputeResolution
 *   7. ReputationRegistry
 *   8. VestingWalletFactory
 *   9. TimelockController
 *  10. DAOGovernor
 *  11. Wire timelock: grant PROPOSER + CANCELLER to Governor
 *  12. Configure transfer-limit exemptions on RIDEToken
 *  13. Transfer protocol contract ownership to Timelock
 *
 * Environment variables (all optional, sensible defaults for local testing):
 *   TREASURY_ADDRESS         – receives initial RIDE supply and platform fees
 *   MATCHER_ADDRESS          – off-chain matching service wallet
 *   RIDE_USD_PRICE_E18       – initial oracle price (1e18 = $1.00), default $0.10
 *   MIN_DRIVER_STAKE_USD_E18 – USD minimum stake (1e18 = $1.00), default $100
 *   PLATFORM_FEE_BPS         – must be ≤ 1000 (10%), default 1000
 *   REQUEST_TIMEOUT_SEC      – unmatched-ride refund window, default 15 min
 *   RIDE_TIMEOUT_SEC         – stuck matched/active ride refund window, default 2 h
 *   UNSTAKE_COOLDOWN_SEC     – driver unstake cooldown, default 7 days
 *   MIN_ARBITRATOR_STAKE     – minimum RIDE to join arbitrator pool, default 50 RIDE
 *   VOTING_PERIOD_SEC        – dispute voting window, default 48 h
 *   JUROR_REWARD_PER_CASE    – RIDE reward per resolved case, default 5 RIDE
 *   TIMELOCK_MIN_DELAY_SEC   – governor timelock delay, default 48 h
 */

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  const matcher  = process.env.MATCHER_ADDRESS  || deployer.address;

  // ── 1. RIDE Token ────────────────────────────────────────────────────────
  const RIDEToken = await ethers.getContractFactory("RIDEToken");
  const rideToken = await RIDEToken.deploy(treasury);
  await rideToken.waitForDeployment();

  // ── 2. Oracle ────────────────────────────────────────────────────────────
  // Default: 1 RIDE = $0.10  →  0.1 * 1e18 = 1e17
  const initialPriceE18 = process.env.RIDE_USD_PRICE_E18 || ethers.parseEther("0.1").toString();
  const ManualRideUsdOracle = await ethers.getContractFactory("ManualRideUsdOracle");
  const oracle = await ManualRideUsdOracle.deploy(deployer.address, initialPriceE18);
  await oracle.waitForDeployment();

  // ── 3. DriverStaking (USD-denominated, $100 minimum by default) ──────────
  const minDriverStakeUsdE18 = process.env.MIN_DRIVER_STAKE_USD_E18 || ethers.parseEther("100").toString();
  const unstakeCooldown      = Number(process.env.UNSTAKE_COOLDOWN_SEC || 7 * 24 * 60 * 60);
  const DriverStaking = await ethers.getContractFactory("DriverStaking");
  const driverStaking = await DriverStaking.deploy(
    rideToken.target,
    oracle.target,
    treasury,
    minDriverStakeUsdE18,
    unstakeCooldown
  );
  await driverStaking.waitForDeployment();

  // ── 4. RideEscrow (deployer as temp dispute resolver) ────────────────────
  const platformFeeBps  = Number(process.env.PLATFORM_FEE_BPS    || 1000);           // 10%
  const requestTimeout  = Number(process.env.REQUEST_TIMEOUT_SEC  || 15 * 60);        // 15 min
  const rideTimeout     = Number(process.env.RIDE_TIMEOUT_SEC     || 2 * 60 * 60);    // 2 h
  const RideEscrow = await ethers.getContractFactory("RideEscrow");
  const rideEscrow = await RideEscrow.deploy(
    driverStaking.target,
    treasury,
    matcher,
    deployer.address,   // temporary; replaced in step 6
    platformFeeBps,
    requestTimeout,
    rideTimeout
  );
  await rideEscrow.waitForDeployment();

  // ── 5. DisputeResolution ─────────────────────────────────────────────────
  const minArbitratorStake = process.env.MIN_ARBITRATOR_STAKE  || ethers.parseEther("50").toString();
  const votingPeriod       = Number(process.env.VOTING_PERIOD_SEC || 48 * 60 * 60);   // 48 h
  const jurorRewardPerCase = process.env.JUROR_REWARD_PER_CASE || ethers.parseEther("5").toString();
  const DisputeResolution = await ethers.getContractFactory("DisputeResolution");
  const disputeResolution = await DisputeResolution.deploy(
    rideToken.target,
    rideEscrow.target,
    treasury,
    minArbitratorStake,
    votingPeriod,
    jurorRewardPerCase
  );
  await disputeResolution.waitForDeployment();

  // ── 6. Patch RideEscrow dispute resolver ────────────────────────────────
  await rideEscrow.setDisputeResolver(disputeResolution.target);

  // ── 7. ReputationRegistry ────────────────────────────────────────────────
  // minimumDriverAverage = 4.0 stars (4e18)
  const ReputationRegistry = await ethers.getContractFactory("ReputationRegistry");
  const reputationRegistry = await ReputationRegistry.deploy(
    rideEscrow.target,
    ethers.parseEther("4")
  );
  await reputationRegistry.waitForDeployment();

  // ── 8. VestingWalletFactory ──────────────────────────────────────────────
  const VestingWalletFactory = await ethers.getContractFactory("VestingWalletFactory");
  const vestingFactory = await VestingWalletFactory.deploy(deployer.address);
  await vestingFactory.waitForDeployment();

  // ── 9. TimelockController ────────────────────────────────────────────────
  const timelockDelay = Number(process.env.TIMELOCK_MIN_DELAY_SEC || 48 * 60 * 60); // 48 h
  const TimelockController = await ethers.getContractFactory("TimelockController");
  const timelock = await TimelockController.deploy(
    timelockDelay,
    [],                        // no initial proposers — granted to governor below
    [ethers.ZeroAddress],      // any executor (open execution after delay)
    deployer.address           // initial admin; revoked after governor is wired
  );
  await timelock.waitForDeployment();

  // ── 10. DAOGovernor ──────────────────────────────────────────────────────
  const DAOGovernor = await ethers.getContractFactory("DAOGovernor");
  const governor = await DAOGovernor.deploy(rideToken.target, timelock.target);
  await governor.waitForDeployment();

  // ── 11. Wire timelock roles ──────────────────────────────────────────────
  const proposerRole  = await timelock.PROPOSER_ROLE();
  const cancellerRole = await timelock.CANCELLER_ROLE();
  const executorRole  = await timelock.EXECUTOR_ROLE();
  const adminRole     = await timelock.DEFAULT_ADMIN_ROLE();

  await timelock.grantRole(proposerRole,  governor.target);
  await timelock.grantRole(cancellerRole, governor.target);
  // Executor already open (ZeroAddress granted above).
  // Revoke deployer admin so the timelock is fully decentralized:
  await timelock.revokeRole(adminRole, deployer.address);

  // ── 12. Configure RIDE transfer-limit exemptions ─────────────────────────
  // Operational contracts that move large amounts must bypass launch transfer limits.
  const rideTokenAsOwner = rideToken.connect(deployer);
  await rideTokenAsOwner.setTransferLimitExempt(rideEscrow.target,       true);
  await rideTokenAsOwner.setTransferLimitExempt(disputeResolution.target, true);
  await rideTokenAsOwner.setTransferLimitExempt(driverStaking.target,    true);
  await rideTokenAsOwner.setTransferLimitExempt(vestingFactory.target,   true);

  // ── 13. Transfer protocol ownership to Timelock ──────────────────────────
  // After this step all parameter changes require a governance proposal.
  // IMPORTANT: ensure at least one token holder has delegated votes before revoking
  // the deployer's RIDE/voting position, otherwise the DAO cannot reach quorum.
  await rideEscrow.transferOwnership(timelock.target);
  await driverStaking.transferOwnership(timelock.target);
  await disputeResolution.transferOwnership(timelock.target);
  await reputationRegistry.transferOwnership(timelock.target);
  await vestingFactory.transferOwnership(timelock.target);
  await oracle.transferOwnership(timelock.target);
  // RIDEToken owner controls transfer limits; hand to timelock last.
  await rideToken.transferOwnership(timelock.target);

  console.log("\nDecride protocol deployed successfully.\n");
  console.table({
    rideToken:         rideToken.target,
    oracle:            oracle.target,
    driverStaking:     driverStaking.target,
    rideEscrow:        rideEscrow.target,
    disputeResolution: disputeResolution.target,
    reputationRegistry: reputationRegistry.target,
    vestingFactory:    vestingFactory.target,
    timelock:          timelock.target,
    governor:          governor.target,
  });

  console.log(
    "\nNOTE: All protocol contracts are now owned by the Timelock. " +
    "Future parameter changes require a DAO governance proposal.\n"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

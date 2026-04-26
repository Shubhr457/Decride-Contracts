/**
 * Integration test: verifies the full deployment wiring matches docs/contract-spec.md.
 * Replicates the steps in scripts/deploy.js without external env vars.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Integration – deploy wiring", function () {
  it("wires all contracts according to the deployment spec", async function () {
    const [deployer, treasury, matcher] = await ethers.getSigners();

    // 1. RIDE Token
    const RIDEToken = await ethers.getContractFactory("RIDEToken");
    const rideToken = await RIDEToken.deploy(treasury.address);
    await rideToken.waitForDeployment();

    // 2. Oracle
    const Oracle = await ethers.getContractFactory("ManualRideUsdOracle");
    const oracle = await Oracle.deploy(deployer.address, ethers.parseEther("1")); // $1/RIDE
    await oracle.waitForDeployment();

    // 3. DriverStaking ($100 USD, no cooldown for tests)
    const DriverStaking = await ethers.getContractFactory("DriverStaking");
    const driverStaking = await DriverStaking.deploy(
      rideToken.target, oracle.target, treasury.address, ethers.parseEther("100"), 0
    );
    await driverStaking.waitForDeployment();

    // 4. RideEscrow (deployer as temp resolver)
    const RideEscrow = await ethers.getContractFactory("RideEscrow");
    const rideEscrow = await RideEscrow.deploy(
      driverStaking.target, treasury.address, matcher.address,
      deployer.address, 1000, 900, 7200
    );
    await rideEscrow.waitForDeployment();

    // 5. DisputeResolution
    const DisputeResolution = await ethers.getContractFactory("DisputeResolution");
    const disputeResolution = await DisputeResolution.deploy(
      rideToken.target, rideEscrow.target, treasury.address,
      ethers.parseEther("50"), 48 * 3600, ethers.parseEther("5")
    );
    await disputeResolution.waitForDeployment();

    // 6. Patch dispute resolver
    await rideEscrow.setDisputeResolver(disputeResolution.target);

    // 7. ReputationRegistry
    const ReputationRegistry = await ethers.getContractFactory("ReputationRegistry");
    const reputationRegistry = await ReputationRegistry.deploy(
      rideEscrow.target, ethers.parseEther("4")
    );
    await reputationRegistry.waitForDeployment();

    // 8. VestingWalletFactory
    const VestingWalletFactory = await ethers.getContractFactory("VestingWalletFactory");
    const vestingFactory = await VestingWalletFactory.deploy(deployer.address);
    await vestingFactory.waitForDeployment();

    // 9. TimelockController
    const TimelockController = await ethers.getContractFactory("TimelockController");
    const timelock = await TimelockController.deploy(
      48 * 3600, [], [ethers.ZeroAddress], deployer.address
    );
    await timelock.waitForDeployment();

    // 10. DAOGovernor
    const DAOGovernor = await ethers.getContractFactory("DAOGovernor");
    const governor = await DAOGovernor.deploy(rideToken.target, timelock.target);
    await governor.waitForDeployment();

    // 11. Wire timelock roles
    const proposerRole  = await timelock.PROPOSER_ROLE();
    const cancellerRole = await timelock.CANCELLER_ROLE();
    const adminRole     = await timelock.DEFAULT_ADMIN_ROLE();
    await timelock.grantRole(proposerRole,  governor.target);
    await timelock.grantRole(cancellerRole, governor.target);
    await timelock.revokeRole(adminRole, deployer.address);

    // 12. Transfer-limit exemptions
    await rideToken.connect(treasury).setTransferLimitExempt(rideEscrow.target,       true);
    await rideToken.connect(treasury).setTransferLimitExempt(disputeResolution.target, true);
    await rideToken.connect(treasury).setTransferLimitExempt(driverStaking.target,    true);
    await rideToken.connect(treasury).setTransferLimitExempt(vestingFactory.target,   true);

    // 13. Transfer ownership to timelock
    await rideEscrow.transferOwnership(timelock.target);
    await driverStaking.transferOwnership(timelock.target);
    await disputeResolution.transferOwnership(timelock.target);
    await reputationRegistry.transferOwnership(timelock.target);
    await vestingFactory.transferOwnership(timelock.target);
    await oracle.transferOwnership(timelock.target);
    await rideToken.connect(treasury).transferOwnership(timelock.target);

    // ── Assertions ──

    // Dispute resolver wired correctly
    expect(await rideEscrow.disputeResolver()).to.equal(disputeResolution.target);

    // Governor is the proposer on timelock
    expect(await timelock.hasRole(proposerRole,  governor.target)).to.equal(true);
    expect(await timelock.hasRole(cancellerRole, governor.target)).to.equal(true);

    // Deployer admin role revoked
    expect(await timelock.hasRole(adminRole, deployer.address)).to.equal(false);

    // All protocol contracts owned by timelock
    expect(await rideEscrow.owner()).to.equal(timelock.target);
    expect(await driverStaking.owner()).to.equal(timelock.target);
    expect(await disputeResolution.owner()).to.equal(timelock.target);
    expect(await reputationRegistry.owner()).to.equal(timelock.target);
    expect(await vestingFactory.owner()).to.equal(timelock.target);
    expect(await oracle.owner()).to.equal(timelock.target);
    expect(await rideToken.owner()).to.equal(timelock.target);

    // Governor parameters match SOW
    expect(await governor.name()).to.equal("Decride DAO");
    expect(await governor.votingDelay()).to.equal(7 * 24 * 3600);
    expect(await governor.votingPeriod()).to.equal(14 * 24 * 3600);
    expect(await governor.quorumNumerator()).to.equal(4);

    // Fee cap enforced
    expect(await rideEscrow.MAX_PLATFORM_FEE_BPS()).to.equal(1000);
    expect(await rideEscrow.platformFeeBps()).to.be.lte(1000);

    // Oracle connected to staking
    expect(await driverStaking.oracle()).to.equal(oracle.target);

    // RIDE token supply
    expect(await rideToken.totalSupply()).to.equal(ethers.parseEther("1000000000"));
  });
});

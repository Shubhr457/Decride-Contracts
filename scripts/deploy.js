const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  const matcher = process.env.MATCHER_ADDRESS || deployer.address;

  const RIDEToken = await ethers.getContractFactory("RIDEToken");
  const rideToken = await RIDEToken.deploy(treasury);
  await rideToken.waitForDeployment();

  const DriverStaking = await ethers.getContractFactory("DriverStaking");
  const driverStaking = await DriverStaking.deploy(
    rideToken.target,
    treasury,
    ethers.parseEther(process.env.MIN_DRIVER_STAKE || "100"),
    Number(process.env.UNSTAKE_COOLDOWN || 7 * 24 * 60 * 60)
  );
  await driverStaking.waitForDeployment();

  const RideEscrow = await ethers.getContractFactory("RideEscrow");
  const rideEscrow = await RideEscrow.deploy(
    driverStaking.target,
    treasury,
    matcher,
    deployer.address,
    Number(process.env.PLATFORM_FEE_BPS || 1000),
    Number(process.env.REQUEST_TIMEOUT || 15 * 60)
  );
  await rideEscrow.waitForDeployment();

  const DisputeResolution = await ethers.getContractFactory("DisputeResolution");
  const disputeResolution = await DisputeResolution.deploy(
    rideToken.target,
    rideEscrow.target,
    treasury,
    ethers.parseEther(process.env.MIN_ARBITRATOR_STAKE || "50"),
    Number(process.env.VOTING_PERIOD || 48 * 60 * 60)
  );
  await disputeResolution.waitForDeployment();
  await rideEscrow.setDisputeResolver(disputeResolution.target);

  const ReputationRegistry = await ethers.getContractFactory("ReputationRegistry");
  const reputationRegistry = await ReputationRegistry.deploy(rideEscrow.target, ethers.parseEther("4"));
  await reputationRegistry.waitForDeployment();

  const TimelockController = await ethers.getContractFactory("TimelockController");
  const timelock = await TimelockController.deploy(48 * 60 * 60, [], [ethers.ZeroAddress], deployer.address);
  await timelock.waitForDeployment();

  const DAOGovernor = await ethers.getContractFactory("DAOGovernor");
  const governor = await DAOGovernor.deploy(rideToken.target, timelock.target);
  await governor.waitForDeployment();

  const proposerRole = await timelock.PROPOSER_ROLE();
  const cancellerRole = await timelock.CANCELLER_ROLE();
  await timelock.grantRole(proposerRole, governor.target);
  await timelock.grantRole(cancellerRole, governor.target);

  console.table({
    rideToken: rideToken.target,
    driverStaking: driverStaking.target,
    rideEscrow: rideEscrow.target,
    disputeResolution: disputeResolution.target,
    reputationRegistry: reputationRegistry.target,
    timelock: timelock.target,
    governor: governor.target
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

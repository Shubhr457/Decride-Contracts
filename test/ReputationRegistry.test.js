const { expect } = require("chai");
const { ethers } = require("hardhat");

const metadataHash = ethers.id("ride:rating-case");

const PRICE_E18    = ethers.parseEther("1");
const MIN_STAKE_USD = ethers.parseEther("100");

describe("ReputationRegistry", function () {
  async function deployFixture() {
    const [treasury, matcher, resolver, rider, driver, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);

    const Oracle = await ethers.getContractFactory("ManualRideUsdOracle");
    const oracle = await Oracle.deploy(treasury.address, PRICE_E18);

    const Staking = await ethers.getContractFactory("DriverStaking");
    const staking = await Staking.deploy(token.target, oracle.target, treasury.address, MIN_STAKE_USD, 0);

    const Escrow = await ethers.getContractFactory("RideEscrow");
    const escrow = await Escrow.deploy(
      staking.target, treasury.address, matcher.address, resolver.address, 1_000, 900, 7200
    );

    const Reputation = await ethers.getContractFactory("ReputationRegistry");
    const reputation = await Reputation.deploy(escrow.target, ethers.parseEther("4"));

    await token.connect(treasury).setTransferLimitExempt(escrow.target,  true);
    await token.connect(treasury).setTransferLimitExempt(staking.target, true);
    await token.connect(treasury).transfer(rider.address,  ethers.parseEther("100"));
    await token.connect(treasury).transfer(driver.address, MIN_STAKE_USD);
    await token.connect(driver).approve(staking.target, MIN_STAKE_USD);
    await staking.connect(driver).stake(MIN_STAKE_USD);
    await token.connect(rider).approve(escrow.target, ethers.MaxUint256);

    // Complete a ride (rideId = 1)
    await escrow.connect(rider).requestRide(token.target, ethers.parseEther("20"), metadataHash);
    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);
    await escrow.connect(rider).confirmCompletion(1);
    await escrow.connect(driver).confirmCompletion(1);

    return { reputation, rider, driver, outsider };
  }

  it("lets completed ride participants rate each other", async function () {
    const { reputation, rider, driver } = await deployFixture();

    await expect(reputation.connect(rider).submitRating(1, 5))
      .to.emit(reputation, "RatingSubmitted")
      .withArgs(1, rider.address, driver.address, 1, 5);

    await reputation.connect(driver).submitRating(1, 4);

    const driverRep = await reputation.driverReputation(driver.address);
    const riderRep  = await reputation.riderReputation(rider.address);

    expect(driverRep.ratingCount).to.equal(1);
    expect(driverRep.averageScoreE18).to.equal(ethers.parseEther("5"));
    expect(riderRep.ratingCount).to.equal(1);
    expect(riderRep.averageScoreE18).to.equal(ethers.parseEther("4"));
  });

  it("rejects duplicate ratings and fake reviewers", async function () {
    const { reputation, rider, outsider } = await deployFixture();

    await reputation.connect(rider).submitRating(1, 5);

    await expect(reputation.connect(rider).submitRating(1, 4)).to.be.revertedWithCustomError(
      reputation, "RatingAlreadySubmitted"
    );
    await expect(reputation.connect(outsider).submitRating(1, 5)).to.be.revertedWithCustomError(
      reputation, "NotRideParticipant"
    );
  });

  it("rejects scores outside the 1 to 5 range", async function () {
    const { reputation, rider } = await deployFixture();

    await expect(reputation.connect(rider).submitRating(1, 0)).to.be.revertedWithCustomError(
      reputation, "InvalidScore"
    );
    await expect(reputation.connect(rider).submitRating(1, 6)).to.be.revertedWithCustomError(
      reputation, "InvalidScore"
    );
  });

  it("isDriverAboveThreshold returns true when driver has no ratings yet", async function () {
    const { reputation, driver } = await deployFixture();
    expect(await reputation.isDriverAboveThreshold(driver.address)).to.equal(true);
  });

  it("isDriverAboveThreshold reflects rating against the minimum average", async function () {
    const { reputation, rider, driver } = await deployFixture();
    // Rate driver 3 stars → average 3.0 < 4.0 threshold
    await reputation.connect(rider).submitRating(1, 3);
    expect(await reputation.isDriverAboveThreshold(driver.address)).to.equal(false);
  });

  it("setRideEscrow rejects zero address", async function () {
    const { reputation } = await deployFixture();
    await expect(reputation.setRideEscrow(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      reputation, "ZeroAddress"
    );
  });

  it("setMinimumDriverAverage updates the threshold", async function () {
    const { reputation } = await deployFixture();
    await reputation.setMinimumDriverAverage(ethers.parseEther("4.5"));
    expect(await reputation.minimumDriverAverageE18()).to.equal(ethers.parseEther("4.5"));
  });

  it("rejects rating on a non-completed ride (RideNotCompleted)", async function () {
    const { reputation, rider } = await deployFixture();
    // rideId 999 doesn't exist → status = 0 (None) ≠ 4 (Completed)
    await expect(reputation.connect(rider).submitRating(999, 5)).to.be.revertedWithCustomError(
      reputation, "RideNotCompleted"
    );
  });

  it("setRideEscrow accepts a valid address and emits RideEscrowUpdated", async function () {
    const { reputation, outsider } = await deployFixture();
    await expect(reputation.setRideEscrow(outsider.address))
      .to.emit(reputation, "RideEscrowUpdated")
      .withArgs(outsider.address);
    expect(await reputation.rideEscrow()).to.equal(outsider.address);
  });

  it("constructor rejects zero rideEscrow address", async function () {
    const Reputation = await ethers.getContractFactory("ReputationRegistry");
    await expect(
      Reputation.deploy(ethers.ZeroAddress, ethers.parseEther("4"))
    ).to.be.revertedWithCustomError({ interface: Reputation.interface }, "ZeroAddress");
  });

  // ── Non-owner access control ───────────────────────────────────────────────

  it("setRideEscrow reverts for non-owner caller", async function () {
    const { reputation, outsider } = await deployFixture();
    await expect(
      reputation.connect(outsider).setRideEscrow(outsider.address)
    ).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
  });

  it("setMinimumDriverAverage reverts for non-owner caller", async function () {
    const { reputation, outsider } = await deployFixture();
    await expect(
      reputation.connect(outsider).setMinimumDriverAverage(ethers.parseEther("3"))
    ).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
  });
});

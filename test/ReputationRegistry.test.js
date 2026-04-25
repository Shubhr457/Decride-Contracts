const { expect } = require("chai");
const { ethers } = require("hardhat");

const metadataHash = ethers.id("ride:rating-case");

describe("ReputationRegistry", function () {
  async function deployFixture() {
    const [treasury, matcher, resolver, rider, driver, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);

    const minimumStake = ethers.parseEther("100");
    const Staking = await ethers.getContractFactory("DriverStaking");
    const staking = await Staking.deploy(token.target, treasury.address, minimumStake, 0);

    const Escrow = await ethers.getContractFactory("RideEscrow");
    const escrow = await Escrow.deploy(staking.target, treasury.address, matcher.address, resolver.address, 1_000, 900);

    const Reputation = await ethers.getContractFactory("ReputationRegistry");
    const reputation = await Reputation.deploy(escrow.target, ethers.parseEther("4"));

    await token.connect(treasury).setTransferLimitExempt(escrow.target, true);
    await token.connect(treasury).transfer(rider.address, ethers.parseEther("100"));
    await token.connect(treasury).transfer(driver.address, minimumStake);
    await token.connect(driver).approve(staking.target, minimumStake);
    await staking.connect(driver).stake(minimumStake);
    await token.connect(rider).approve(escrow.target, ethers.MaxUint256);

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
    const riderRep = await reputation.riderReputation(rider.address);

    expect(driverRep.ratingCount).to.equal(1);
    expect(driverRep.averageScoreE18).to.equal(ethers.parseEther("5"));
    expect(riderRep.ratingCount).to.equal(1);
    expect(riderRep.averageScoreE18).to.equal(ethers.parseEther("4"));
  });

  it("rejects duplicate ratings and fake reviewers", async function () {
    const { reputation, rider, outsider } = await deployFixture();

    await reputation.connect(rider).submitRating(1, 5);

    await expect(reputation.connect(rider).submitRating(1, 4)).to.be.revertedWithCustomError(
      reputation,
      "RatingAlreadySubmitted"
    );
    await expect(reputation.connect(outsider).submitRating(1, 5)).to.be.revertedWithCustomError(
      reputation,
      "NotRideParticipant"
    );
  });

  it("rejects scores outside the 1 to 5 range", async function () {
    const { reputation, rider } = await deployFixture();

    await expect(reputation.connect(rider).submitRating(1, 0)).to.be.revertedWithCustomError(
      reputation,
      "InvalidScore"
    );
    await expect(reputation.connect(rider).submitRating(1, 6)).to.be.revertedWithCustomError(
      reputation,
      "InvalidScore"
    );
  });
});

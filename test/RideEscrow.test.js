const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const metadataHash = ethers.id("ride:pickup-dropoff-hash");
const evidenceHash = ethers.id("ipfs:evidence");

describe("RideEscrow", function () {
  async function deployFixture() {
    const [treasury, matcher, resolver, rider, driver, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);

    const minimumStake = ethers.parseEther("100");
    const Staking = await ethers.getContractFactory("DriverStaking");
    const staking = await Staking.deploy(token.target, treasury.address, minimumStake, 7 * 24 * 60 * 60);

    const Escrow = await ethers.getContractFactory("RideEscrow");
    const escrow = await Escrow.deploy(
      staking.target,
      treasury.address,
      matcher.address,
      resolver.address,
      1_000,
      15 * 60
    );

    await token.connect(treasury).setTransferLimitExempt(escrow.target, true);
    await token.connect(treasury).transfer(rider.address, ethers.parseEther("1000"));
    await token.connect(treasury).transfer(driver.address, minimumStake);
    await token.connect(driver).approve(staking.target, minimumStake);
    await staking.connect(driver).stake(minimumStake);
    await token.connect(rider).approve(escrow.target, ethers.MaxUint256);

    return { token, staking, escrow, treasury, matcher, resolver, rider, driver, outsider };
  }

  async function requestRide(escrow, token, rider, fare = ethers.parseEther("50")) {
    await escrow.connect(rider).requestRide(token.target, fare, metadataHash);
    return { rideId: 1n, fare };
  }

  it("escrows rider funds when a ride is requested", async function () {
    const { token, escrow, rider } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);

    const ride = await escrow.rides(1);
    expect(ride.rider).to.equal(rider.address);
    expect(ride.fareAmount).to.equal(fare);
    expect(ride.status).to.equal(1);
    expect(await token.balanceOf(escrow.target)).to.equal(fare);
  });

  it("matches only active drivers through the matcher", async function () {
    const { token, escrow, matcher, driver, outsider, rider } = await deployFixture();
    await requestRide(escrow, token, rider);

    await expect(escrow.connect(outsider).matchRide(1, driver.address)).to.be.revertedWithCustomError(
      escrow,
      "NotMatcher"
    );

    await expect(escrow.connect(matcher).matchRide(1, outsider.address)).to.be.revertedWithCustomError(
      escrow,
      "DriverNotActive"
    );

    await escrow.connect(matcher).matchRide(1, driver.address);
    const ride = await escrow.rides(1);
    expect(ride.driver).to.equal(driver.address);
    expect(ride.status).to.equal(2);
  });

  it("settles fare after rider and driver confirm completion", async function () {
    const { token, escrow, treasury, matcher, rider, driver } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);

    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);

    await escrow.connect(rider).confirmCompletion(1);
    expect((await escrow.rides(1)).status).to.equal(3);

    const driverBefore = await token.balanceOf(driver.address);
    const treasuryBefore = await token.balanceOf(treasury.address);

    await escrow.connect(driver).confirmCompletion(1);

    expect(await token.balanceOf(driver.address)).to.equal(driverBefore + (fare * 9n) / 10n);
    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + fare / 10n);
    expect((await escrow.rides(1)).status).to.equal(4);
  });

  it("refunds an unmatched ride after the request timeout", async function () {
    const { token, escrow, rider } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);
    const riderBefore = await token.balanceOf(rider.address);

    await expect(escrow.refundExpiredRequest(1)).to.be.revertedWithCustomError(escrow, "RequestStillActive");
    await time.increase(15 * 60);

    await escrow.refundExpiredRequest(1);

    expect(await token.balanceOf(rider.address)).to.equal(riderBefore + fare);
    expect((await escrow.rides(1)).status).to.equal(6);
  });

  it("lets the resolver split disputed escrow funds", async function () {
    const { token, escrow, matcher, resolver, rider, driver } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);

    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);
    await escrow.connect(rider).disputeRide(1, evidenceHash);

    const driverAward = fare / 2n;
    const riderAward = fare - driverAward;
    const driverBefore = await token.balanceOf(driver.address);
    const riderBefore = await token.balanceOf(rider.address);

    await escrow.connect(resolver).resolveDispute(1, driverAward, riderAward);

    expect(await token.balanceOf(driver.address)).to.equal(driverBefore + (driverAward * 9n) / 10n);
    expect(await token.balanceOf(rider.address)).to.equal(riderBefore + riderAward);
    expect((await escrow.rides(1)).status).to.equal(4);
  });
});

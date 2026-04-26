const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const metadataHash = ethers.id("ride:pickup-dropoff-hash");
const evidenceHash = ethers.id("ipfs:evidence");

const PRICE_E18      = ethers.parseEther("1");    // $1.00 per RIDE
const MIN_STAKE_USD  = ethers.parseEther("100");  // $100 minimum → 100 RIDE required
const REQUEST_TIMEOUT = 15 * 60;                   // 15 min
const RIDE_TIMEOUT    = 2 * 60 * 60;               // 2 h

describe("RideEscrow", function () {
  async function deployFixture() {
    const [treasury, matcher, resolver, rider, driver, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);

    const Oracle = await ethers.getContractFactory("ManualRideUsdOracle");
    const oracle = await Oracle.deploy(treasury.address, PRICE_E18);

    const Staking = await ethers.getContractFactory("DriverStaking");
    const staking = await Staking.deploy(
      token.target, oracle.target, treasury.address, MIN_STAKE_USD, 7 * 24 * 60 * 60
    );

    const Escrow = await ethers.getContractFactory("RideEscrow");
    const escrow = await Escrow.deploy(
      staking.target, treasury.address, matcher.address, resolver.address,
      1_000, REQUEST_TIMEOUT, RIDE_TIMEOUT
    );

    await token.connect(treasury).setTransferLimitExempt(escrow.target, true);
    await token.connect(treasury).setTransferLimitExempt(staking.target, true);

    const driverStake = await staking.requiredRideStakeAmount();
    await token.connect(treasury).transfer(rider.address,  ethers.parseEther("1000"));
    await token.connect(treasury).transfer(driver.address, driverStake);
    await token.connect(driver).approve(staking.target, driverStake);
    await staking.connect(driver).stake(driverStake);
    await token.connect(rider).approve(escrow.target, ethers.MaxUint256);

    return { token, staking, escrow, oracle, treasury, matcher, resolver, rider, driver, outsider };
  }

  async function requestRide(escrow, token, rider, fare = ethers.parseEther("50")) {
    await escrow.connect(rider).requestRide(token.target, fare, metadataHash);
    return { rideId: 1n, fare };
  }

  // ── Existing coverage ─────────────────────────────────────────────────────

  it("escrows rider funds when a ride is requested", async function () {
    const { token, escrow, rider } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);

    const ride = await escrow.rides(1);
    expect(ride.rider).to.equal(rider.address);
    expect(ride.fareAmount).to.equal(fare);
    expect(ride.status).to.equal(1); // Requested
    expect(await token.balanceOf(escrow.target)).to.equal(fare);
  });

  it("matches only active drivers through the matcher", async function () {
    const { token, escrow, matcher, driver, outsider, rider } = await deployFixture();
    await requestRide(escrow, token, rider);

    await expect(escrow.connect(outsider).matchRide(1, driver.address)).to.be.revertedWithCustomError(
      escrow, "NotMatcher"
    );
    await expect(escrow.connect(matcher).matchRide(1, outsider.address)).to.be.revertedWithCustomError(
      escrow, "DriverNotActive"
    );

    await escrow.connect(matcher).matchRide(1, driver.address);
    const ride = await escrow.rides(1);
    expect(ride.driver).to.equal(driver.address);
    expect(ride.status).to.equal(2); // Matched
  });

  it("settles fare after rider and driver confirm completion", async function () {
    const { token, escrow, treasury, matcher, rider, driver } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);

    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);

    await escrow.connect(rider).confirmCompletion(1);
    expect((await escrow.rides(1)).status).to.equal(3); // still Active until both confirm

    const driverBefore   = await token.balanceOf(driver.address);
    const treasuryBefore = await token.balanceOf(treasury.address);

    await escrow.connect(driver).confirmCompletion(1);

    expect(await token.balanceOf(driver.address)).to.equal(driverBefore + (fare * 9n) / 10n);
    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + fare / 10n);
    expect((await escrow.rides(1)).status).to.equal(4); // Completed
  });

  it("refunds an unmatched ride after the request timeout", async function () {
    const { token, escrow, rider } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);
    const riderBefore = await token.balanceOf(rider.address);

    await expect(escrow.refundExpiredRequest(1)).to.be.revertedWithCustomError(escrow, "RequestStillActive");
    await time.increase(REQUEST_TIMEOUT);

    await escrow.refundExpiredRequest(1);

    expect(await token.balanceOf(rider.address)).to.equal(riderBefore + fare);
    expect((await escrow.rides(1)).status).to.equal(6); // Refunded
  });

  it("lets the resolver split disputed escrow funds", async function () {
    const { token, escrow, matcher, resolver, rider, driver } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);

    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);
    await escrow.connect(rider).disputeRide(1, evidenceHash);

    const driverAward  = fare / 2n;
    const riderAward   = fare - driverAward;
    const driverBefore = await token.balanceOf(driver.address);
    const riderBefore  = await token.balanceOf(rider.address);

    await escrow.connect(resolver).resolveDispute(1, driverAward, riderAward);

    expect(await token.balanceOf(driver.address)).to.equal(driverBefore + (driverAward * 9n) / 10n);
    expect(await token.balanceOf(rider.address)).to.equal(riderBefore  + riderAward);
    expect((await escrow.rides(1)).status).to.equal(4); // Completed
  });

  // ── Fee cap (SOW: hard limit of 10%) ─────────────────────────────────────

  it("rejects constructor platform fee above 10%", async function () {
    const [treasury, matcher, resolver] = await ethers.getSigners();
    const token   = await (await ethers.getContractFactory("RIDEToken")).deploy(treasury.address);
    const oracle  = await (await ethers.getContractFactory("ManualRideUsdOracle")).deploy(treasury.address, PRICE_E18);
    const staking = await (await ethers.getContractFactory("DriverStaking")).deploy(
      token.target, oracle.target, treasury.address, MIN_STAKE_USD, 0
    );
    const Escrow = await ethers.getContractFactory("RideEscrow");

    await expect(
      Escrow.deploy(staking.target, treasury.address, matcher.address, resolver.address, 1_001, REQUEST_TIMEOUT, RIDE_TIMEOUT)
    ).to.be.revertedWithCustomError({ interface: Escrow.interface }, "FeeTooHigh");
  });

  it("rejects setPlatformFee above 10% (1000 bps)", async function () {
    const { escrow } = await deployFixture();

    await expect(escrow.setPlatformFee(1_001)).to.be.revertedWithCustomError(escrow, "FeeTooHigh");
    await expect(escrow.setPlatformFee(10_000)).to.be.revertedWithCustomError(escrow, "FeeTooHigh");

    await escrow.setPlatformFee(500); // 5% is valid
    expect(await escrow.platformFeeBps()).to.equal(500);
  });

  it("MAX_PLATFORM_FEE_BPS is exactly 1000 bps (10%)", async function () {
    const { escrow } = await deployFixture();
    expect(await escrow.MAX_PLATFORM_FEE_BPS()).to.equal(1_000);
  });

  // ── Stuck ride timeout recovery ───────────────────────────────────────────

  it("refunds a stuck Matched ride after rideTimeout", async function () {
    const { token, escrow, matcher, rider, driver } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);
    const riderBefore = await token.balanceOf(rider.address);

    await escrow.connect(matcher).matchRide(1, driver.address);
    expect((await escrow.rides(1)).status).to.equal(2); // Matched

    await expect(escrow.connect(rider).refundStuckRide(1)).to.be.revertedWithCustomError(escrow, "RideStillActive");

    await time.increase(RIDE_TIMEOUT);
    await escrow.connect(rider).refundStuckRide(1);

    expect(await token.balanceOf(rider.address)).to.equal(riderBefore + fare);
    expect((await escrow.rides(1)).status).to.equal(6); // Refunded
  });

  it("refunds a stuck Active ride after rideTimeout", async function () {
    const { token, escrow, matcher, rider, driver } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);
    const riderBefore = await token.balanceOf(rider.address);

    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);
    expect((await escrow.rides(1)).status).to.equal(3); // Active

    await time.increase(RIDE_TIMEOUT);
    await escrow.connect(driver).refundStuckRide(1); // driver can also trigger

    expect(await token.balanceOf(rider.address)).to.equal(riderBefore + fare);
    expect((await escrow.rides(1)).status).to.equal(6); // Refunded
  });

  it("only a ride participant can call refundStuckRide", async function () {
    const { token, escrow, matcher, rider, driver, outsider } = await deployFixture();
    await requestRide(escrow, token, rider);
    await escrow.connect(matcher).matchRide(1, driver.address);
    await time.increase(RIDE_TIMEOUT);

    await expect(escrow.connect(outsider).refundStuckRide(1)).to.be.revertedWithCustomError(
      escrow, "NotRideParticipant"
    );
  });

  // ── Dispute resolver guard ────────────────────────────────────────────────

  it("rejects resolveDispute from a non-resolver with NotDisputeResolver", async function () {
    const { token, escrow, matcher, outsider, rider, driver } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);

    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);
    await escrow.connect(rider).disputeRide(1, evidenceHash);

    await expect(
      escrow.connect(outsider).resolveDispute(1, fare, 0n)
    ).to.be.revertedWithCustomError(escrow, "NotDisputeResolver");
  });

  // ── Rider cancel (unmatched) ──────────────────────────────────────────────

  it("rider can cancel an unmatched request and receive a full refund", async function () {
    const { token, escrow, rider } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);
    const riderBefore = await token.balanceOf(rider.address);

    await escrow.connect(rider).cancelRequest(1);

    expect(await token.balanceOf(rider.address)).to.equal(riderBefore + fare);
    expect((await escrow.rides(1)).status).to.equal(7); // Cancelled
  });

  // ── Ride timeout setter ───────────────────────────────────────────────────

  it("owner can update rideTimeout", async function () {
    const { escrow } = await deployFixture();
    await escrow.setRideTimeout(3 * 60 * 60);
    expect(await escrow.rideTimeout()).to.equal(3 * 60 * 60);
  });

  // ── Setter zero-address guards ────────────────────────────────────────────

  it("setMatcher rejects zero address", async function () {
    const { escrow } = await deployFixture();
    await expect(escrow.setMatcher(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      escrow, "ZeroAddress"
    );
  });

  it("setDisputeResolver rejects zero address", async function () {
    const { escrow } = await deployFixture();
    await expect(escrow.setDisputeResolver(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      escrow, "ZeroAddress"
    );
  });

  it("setTreasury rejects zero address", async function () {
    const { escrow } = await deployFixture();
    await expect(escrow.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      escrow, "ZeroAddress"
    );
  });

  // ── requestRide guard paths ───────────────────────────────────────────────

  it("requestRide rejects zero-address payment token", async function () {
    const { escrow, rider } = await deployFixture();
    await expect(
      escrow.connect(rider).requestRide(ethers.ZeroAddress, ethers.parseEther("10"), metadataHash)
    ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
  });

  it("requestRide rejects zero fare amount", async function () {
    const { token, escrow, rider } = await deployFixture();
    await expect(
      escrow.connect(rider).requestRide(token.target, 0n, metadataHash)
    ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
  });

  // ── Non-existent ride ─────────────────────────────────────────────────────

  it("reverts with RideNotFound for an unknown rideId", async function () {
    const { escrow, matcher, driver } = await deployFixture();
    await expect(escrow.connect(matcher).matchRide(999, driver.address)).to.be.revertedWithCustomError(
      escrow, "RideNotFound"
    );
  });

  // ── Wrong status transitions ──────────────────────────────────────────────

  it("matchRide rejects a non-Requested ride", async function () {
    const { token, escrow, matcher, rider, driver } = await deployFixture();
    await requestRide(escrow, token, rider);
    await escrow.connect(matcher).matchRide(1, driver.address);

    await expect(escrow.connect(matcher).matchRide(1, driver.address)).to.be.revertedWithCustomError(
      escrow, "InvalidRideStatus"
    );
  });

  it("disputeRide rejects a non Matched/Active ride", async function () {
    const { token, escrow, matcher, rider, driver } = await deployFixture();
    await requestRide(escrow, token, rider);
    // Still Requested → cannot dispute
    await expect(escrow.connect(rider).disputeRide(1, evidenceHash)).to.be.revertedWithCustomError(
      escrow, "InvalidRideStatus"
    );
  });

  // ── Zero fee settlement ───────────────────────────────────────────────────

  it("settles with zero platform fee when platformFeeBps is 0", async function () {
    const { token, escrow, matcher, rider, driver } = await deployFixture();
    await escrow.setPlatformFee(0);

    const { fare } = await requestRide(escrow, token, rider);
    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);

    const driverBefore = await token.balanceOf(driver.address);
    await escrow.connect(rider).confirmCompletion(1);
    await escrow.connect(driver).confirmCompletion(1);

    // Driver receives full fare (no fee)
    expect(await token.balanceOf(driver.address)).to.equal(driverBefore + fare);
  });

  // ── Request timeout setter ────────────────────────────────────────────────

  it("owner can update requestTimeout", async function () {
    const { escrow } = await deployFixture();
    await escrow.setRequestTimeout(30 * 60);
    expect(await escrow.requestTimeout()).to.equal(30 * 60);
  });

  // ── Settlement with driverAmount = 0 (full refund to rider) ──────────────

  it("resolveDispute with driverAmount=0 skips driver payout and fee transfer", async function () {
    const { token, escrow, matcher, resolver, rider, driver } = await deployFixture();
    const fare = ethers.parseEther("50");
    await requestRide(escrow, token, rider);
    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);
    await escrow.connect(rider).disputeRide(1, evidenceHash);

    const riderBefore = await token.balanceOf(rider.address);

    // Full refund to rider, zero to driver
    await escrow.connect(resolver).resolveDispute(1, 0n, fare);

    expect(await token.balanceOf(rider.address)).to.equal(riderBefore + fare);
    expect((await escrow.rides(1)).status).to.equal(4); // Completed
  });

  // ── Setter success paths ──────────────────────────────────────────────────

  it("setMatcher accepts a valid address and emits MatcherUpdated", async function () {
    const { escrow, outsider } = await deployFixture();
    await expect(escrow.setMatcher(outsider.address))
      .to.emit(escrow, "MatcherUpdated")
      .withArgs(outsider.address);
    expect(await escrow.matcher()).to.equal(outsider.address);
  });

  it("setDisputeResolver accepts a valid address and emits DisputeResolverUpdated", async function () {
    const { escrow, outsider } = await deployFixture();
    await expect(escrow.setDisputeResolver(outsider.address))
      .to.emit(escrow, "DisputeResolverUpdated")
      .withArgs(outsider.address);
    expect(await escrow.disputeResolver()).to.equal(outsider.address);
  });

  it("setTreasury accepts a valid address and emits TreasuryUpdated", async function () {
    const { escrow, outsider } = await deployFixture();
    await expect(escrow.setTreasury(outsider.address))
      .to.emit(escrow, "TreasuryUpdated")
      .withArgs(outsider.address);
    expect(await escrow.treasury()).to.equal(outsider.address);
  });

  // ── resolveDispute bad split ───────────────────────────────────────────────

  it("resolveDispute rejects amounts not summing to fareAmount", async function () {
    const { token, escrow, matcher, resolver, rider, driver } = await deployFixture();
    const fare = ethers.parseEther("50");
    await requestRide(escrow, token, rider);
    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);
    await escrow.connect(rider).disputeRide(1, evidenceHash);

    await expect(
      escrow.connect(resolver).resolveDispute(1, fare, fare)  // 2x fare ≠ fare
    ).to.be.revertedWithCustomError(escrow, "InvalidDisputeSplit");
  });

  // ── refundStuckRide wrong status ──────────────────────────────────────────

  it("refundStuckRide rejects on a Requested (not Matched/Active) ride", async function () {
    const { token, escrow, rider } = await deployFixture();
    await requestRide(escrow, token, rider);
    // Ride is still Requested (status 1), not Matched/Active
    await expect(escrow.connect(rider).refundStuckRide(1)).to.be.revertedWithCustomError(
      escrow, "InvalidRideStatus"
    );
  });

  // ── cancelRequest non-rider caller ────────────────────────────────────────

  it("cancelRequest rejects caller that is not the rider", async function () {
    const { token, escrow, driver, outsider, rider } = await deployFixture();
    await requestRide(escrow, token, rider);

    await expect(escrow.connect(outsider).cancelRequest(1)).to.be.revertedWithCustomError(
      escrow, "NotRideParticipant"
    );
    await expect(escrow.connect(driver).cancelRequest(1)).to.be.revertedWithCustomError(
      escrow, "NotRideParticipant"
    );
  });

  // ── Constructor zero-address guards ──────────────────────────────────────

  it("constructor rejects zero driverStaking address", async function () {
    const [treasury, matcher, resolver] = await ethers.getSigners();
    const Escrow = await ethers.getContractFactory("RideEscrow");

    await expect(
      Escrow.deploy(ethers.ZeroAddress, treasury.address, matcher.address, resolver.address, 0, 900, 7200)
    ).to.be.revertedWithCustomError({ interface: Escrow.interface }, "ZeroAddress");
  });

  it("constructor rejects zero treasury address", async function () {
    const { staking } = await deployFixture();
    const [, , matcher, resolver] = await ethers.getSigners();
    const Escrow = await ethers.getContractFactory("RideEscrow");

    await expect(
      Escrow.deploy(staking.target, ethers.ZeroAddress, matcher.address, resolver.address, 0, 900, 7200)
    ).to.be.revertedWithCustomError({ interface: Escrow.interface }, "ZeroAddress");
  });

  it("constructor rejects zero matcher address", async function () {
    const { staking, treasury } = await deployFixture();
    const [, , , resolver] = await ethers.getSigners();
    const Escrow = await ethers.getContractFactory("RideEscrow");

    await expect(
      Escrow.deploy(staking.target, treasury.address, ethers.ZeroAddress, resolver.address, 0, 900, 7200)
    ).to.be.revertedWithCustomError({ interface: Escrow.interface }, "ZeroAddress");
  });

  it("constructor rejects zero disputeResolver address", async function () {
    const { staking, treasury, matcher } = await deployFixture();
    const Escrow = await ethers.getContractFactory("RideEscrow");

    await expect(
      Escrow.deploy(staking.target, treasury.address, matcher.address, ethers.ZeroAddress, 0, 900, 7200)
    ).to.be.revertedWithCustomError({ interface: Escrow.interface }, "ZeroAddress");
  });

  // ── confirmCompletion: driver confirms first ──────────────────────────────

  it("settles when driver confirms before rider (driver-first confirmation path)", async function () {
    const { token, escrow, matcher, rider, driver } = await deployFixture();
    const { fare } = await requestRide(escrow, token, rider);

    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);

    // Driver confirms first (riderConfirmed = false → && short-circuits, no settle yet)
    await escrow.connect(driver).confirmCompletion(1);
    expect((await escrow.rides(1)).status).to.equal(3); // still Active

    // Rider confirms → both confirmed → settles
    const driverBefore = await token.balanceOf(driver.address);
    await escrow.connect(rider).confirmCompletion(1);

    expect(await token.balanceOf(driver.address)).to.be.gt(driverBefore);
    expect((await escrow.rides(1)).status).to.equal(4); // Completed
  });

  // ── Non-owner access control ───────────────────────────────────────────────

  it("setMatcher reverts for non-owner caller", async function () {
    const { escrow, outsider } = await deployFixture();
    await expect(
      escrow.connect(outsider).setMatcher(outsider.address)
    ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
  });

  it("setDisputeResolver reverts for non-owner caller", async function () {
    const { escrow, outsider } = await deployFixture();
    await expect(
      escrow.connect(outsider).setDisputeResolver(outsider.address)
    ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
  });

  it("setTreasury reverts for non-owner caller", async function () {
    const { escrow, outsider } = await deployFixture();
    await expect(
      escrow.connect(outsider).setTreasury(outsider.address)
    ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
  });

  it("setPlatformFee reverts for non-owner caller", async function () {
    const { escrow, outsider } = await deployFixture();
    await expect(
      escrow.connect(outsider).setPlatformFee(500)
    ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
  });

  it("setRequestTimeout reverts for non-owner caller", async function () {
    const { escrow, outsider } = await deployFixture();
    await expect(
      escrow.connect(outsider).setRequestTimeout(30 * 60)
    ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
  });

  it("setRideTimeout reverts for non-owner caller", async function () {
    const { escrow, outsider } = await deployFixture();
    await expect(
      escrow.connect(outsider).setRideTimeout(4 * 60 * 60)
    ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
  });
});

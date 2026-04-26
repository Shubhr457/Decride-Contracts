const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const metadataHash = ethers.id("ride:dispute-case");
const evidenceHash = ethers.id("ipfs:dispute-evidence");

const PRICE_E18       = ethers.parseEther("1");
const MIN_STAKE_USD   = ethers.parseEther("100");
const VOTING_PERIOD   = 48 * 60 * 60;
const MIN_ARB_STAKE   = ethers.parseEther("50");
const JUROR_REWARD    = ethers.parseEther("4"); // 4 RIDE per case

describe("DisputeResolution", function () {
  async function deployFixture({ jurorReward = 0n } = {}) {
    const [treasury, matcher, tempResolver, rider, driver, arb1, arb2, arb3, outsider] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);

    const Oracle = await ethers.getContractFactory("ManualRideUsdOracle");
    const oracle = await Oracle.deploy(treasury.address, PRICE_E18);

    const Staking = await ethers.getContractFactory("DriverStaking");
    const staking = await Staking.deploy(token.target, oracle.target, treasury.address, MIN_STAKE_USD, 0);

    const Escrow = await ethers.getContractFactory("RideEscrow");
    const escrow = await Escrow.deploy(
      staking.target, treasury.address, matcher.address, tempResolver.address,
      1_000, 900, 7200
    );

    const Dispute = await ethers.getContractFactory("DisputeResolution");
    const dispute = await Dispute.deploy(
      token.target, escrow.target, treasury.address, MIN_ARB_STAKE, VOTING_PERIOD, jurorReward
    );
    await escrow.connect(treasury).setDisputeResolver(dispute.target);

    await token.connect(treasury).setTransferLimitExempt(escrow.target,  true);
    await token.connect(treasury).setTransferLimitExempt(dispute.target, true);
    await token.connect(treasury).setTransferLimitExempt(staking.target, true);

    await token.connect(treasury).transfer(rider.address,  ethers.parseEther("100"));
    await token.connect(treasury).transfer(driver.address, MIN_STAKE_USD);

    for (const arb of [arb1, arb2, arb3]) {
      await token.connect(treasury).transfer(arb.address, MIN_ARB_STAKE);
      await token.connect(arb).approve(dispute.target, MIN_ARB_STAKE);
      await dispute.connect(arb).stake(MIN_ARB_STAKE);
    }

    await token.connect(driver).approve(staking.target, MIN_STAKE_USD);
    await staking.connect(driver).stake(MIN_STAKE_USD);
    await token.connect(rider).approve(escrow.target, ethers.MaxUint256);

    // Create a disputed ride (rideId = 1)
    await escrow.connect(rider).requestRide(token.target, ethers.parseEther("20"), metadataHash);
    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);
    await escrow.connect(rider).disputeRide(1, evidenceHash);

    return { token, escrow, dispute, oracle, treasury, matcher, rider, driver, arb1, arb2, arb3, outsider };
  }

  // ── Existing coverage (admin openCase path) ───────────────────────────────

  it("opens a case only for a disputed ride with qualified jurors", async function () {
    const { dispute, arb1, arb2, arb3 } = await deployFixture();

    await expect(dispute.openCase(1, [arb1.address, arb2.address, arb3.address]))
      .to.emit(dispute, "CaseOpened")
      .withArgs(1, 1, [arb1.address, arb2.address, arb3.address]);

    const caseData = await dispute.getCase(1);
    expect(caseData.rideId).to.equal(1);
    expect(caseData.jury).to.deep.equal([arb1.address, arb2.address, arb3.address]);
  });

  it("executes the majority outcome through ride escrow (driver wins)", async function () {
    const { token, escrow, dispute, driver, arb1, arb2, arb3 } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);
    await dispute.connect(arb1).vote(1, 1); // Driver
    await dispute.connect(arb2).vote(1, 1); // Driver
    await dispute.connect(arb3).vote(1, 2); // Rider

    await time.increase(VOTING_PERIOD);

    const driverBefore = await token.balanceOf(driver.address);
    await dispute.executeCase(1);

    // Driver wins 20 RIDE minus 10% fee = 18 RIDE; jurorReward = 0 by default
    expect(await token.balanceOf(driver.address)).to.equal(driverBefore + ethers.parseEther("18"));
    expect((await escrow.rides(1)).status).to.equal(4); // Completed
    expect((await dispute.getCase(1)).executed).to.equal(true);
  });

  it("rejects non-juror votes and duplicate votes", async function () {
    const { dispute, arb1, arb2, arb3, outsider } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);

    await expect(dispute.connect(outsider).vote(1, 1)).to.be.revertedWithCustomError(dispute, "NotSelectedJuror");
    await dispute.connect(arb1).vote(1, 3); // Split
    await expect(dispute.connect(arb1).vote(1, 3)).to.be.revertedWithCustomError(dispute, "VoteAlreadySubmitted");
  });

  it("allows governance to slash arbitrator stake", async function () {
    const { token, dispute, treasury, arb1 } = await deployFixture();
    const amount = ethers.parseEther("10");
    const treasuryBefore = await token.balanceOf(treasury.address);

    await dispute.slashArbitrator(arb1.address, amount, "missed votes");

    expect(await dispute.arbitratorStake(arb1.address)).to.equal(ethers.parseEther("40"));
    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + amount);
  });

  // ── Eligible pool management ──────────────────────────────────────────────

  it("registers an arbitrator into the eligible pool after staking", async function () {
    const { dispute, arb1 } = await deployFixture();

    await expect(dispute.connect(arb1).registerAsJuror())
      .to.emit(dispute, "ArbitratorRegistered")
      .withArgs(arb1.address);

    expect(await dispute.eligiblePoolSize()).to.equal(1);
  });

  it("rejects registration if stake is below minimum", async function () {
    const { dispute, outsider } = await deployFixture();

    await expect(dispute.connect(outsider).registerAsJuror()).to.be.revertedWithCustomError(
      dispute, "ArbitratorNotQualified"
    );
  });

  it("rejects duplicate registration", async function () {
    const { dispute, arb1 } = await deployFixture();

    await dispute.connect(arb1).registerAsJuror();
    await expect(dispute.connect(arb1).registerAsJuror()).to.be.revertedWithCustomError(
      dispute, "AlreadyRegistered"
    );
  });

  it("deregisters an arbitrator from the pool", async function () {
    const { dispute, arb1, arb2 } = await deployFixture();

    await dispute.connect(arb1).registerAsJuror();
    await dispute.connect(arb2).registerAsJuror();
    expect(await dispute.eligiblePoolSize()).to.equal(2);

    await expect(dispute.connect(arb1).deregisterAsJuror())
      .to.emit(dispute, "ArbitratorDeregistered")
      .withArgs(arb1.address);

    expect(await dispute.eligiblePoolSize()).to.equal(1);
  });

  it("unstaking below minimum auto-deregisters from the pool", async function () {
    const { dispute, arb1 } = await deployFixture();

    await dispute.connect(arb1).registerAsJuror();
    expect(await dispute.eligiblePoolSize()).to.equal(1);

    // Unstake 1 token → stake falls to 49 < 50 minimum → auto-deregistered
    await dispute.connect(arb1).unstake(ethers.parseEther("1"));
    expect(await dispute.eligiblePoolSize()).to.equal(0);
  });

  // ── openCaseWithRandomJury ────────────────────────────────────────────────

  it("openCaseWithRandomJury selects unique jurors from the eligible pool", async function () {
    const { dispute, arb1, arb2, arb3 } = await deployFixture();

    await dispute.connect(arb1).registerAsJuror();
    await dispute.connect(arb2).registerAsJuror();
    await dispute.connect(arb3).registerAsJuror();
    expect(await dispute.eligiblePoolSize()).to.equal(3);

    const tx = await dispute.openCaseWithRandomJury(1, 3);
    await tx.wait();

    const caseData = await dispute.getCase(1);
    expect(caseData.jury.length).to.equal(3);

    // All three arbitrators must be selected (pool size = jury size)
    expect(await dispute.isJuror(1, arb1.address)).to.equal(true);
    expect(await dispute.isJuror(1, arb2.address)).to.equal(true);
    expect(await dispute.isJuror(1, arb3.address)).to.equal(true);
  });

  it("openCaseWithRandomJury reverts when requested size exceeds pool", async function () {
    const { dispute, arb1 } = await deployFixture();

    await dispute.connect(arb1).registerAsJuror();

    await expect(dispute.openCaseWithRandomJury(1, 3)).to.be.revertedWithCustomError(
      dispute, "JurySizeTooLarge"
    );
  });

  it("openCaseWithRandomJury reverts for an empty pool", async function () {
    const { dispute } = await deployFixture();

    await expect(dispute.openCaseWithRandomJury(1, 0)).to.be.revertedWithCustomError(
      dispute, "EmptyJury"
    );
  });

  // ── Juror rewards ─────────────────────────────────────────────────────────

  it("distributes rewards to winning jurors after case execution", async function () {
    const { token, dispute, treasury, arb1, arb2, arb3 } = await deployFixture({ jurorReward: JUROR_REWARD });

    // Fund reward reserve: 4 RIDE
    await token.connect(treasury).approve(dispute.target, JUROR_REWARD);
    await dispute.connect(treasury).fundRewardReserve(JUROR_REWARD);
    expect(await dispute.rewardReserve()).to.equal(JUROR_REWARD);

    await dispute.connect(arb1).registerAsJuror();
    await dispute.connect(arb2).registerAsJuror();
    await dispute.connect(arb3).registerAsJuror();
    await dispute.openCaseWithRandomJury(1, 3);

    // arb1 and arb2 vote Driver (winner); arb3 votes Rider
    const caseData = await dispute.getCase(1);
    const jury     = caseData.jury;

    // Vote as the specific jurors by address
    const signerMap = Object.fromEntries(
      [arb1, arb2, arb3].map(s => [s.address.toLowerCase(), s])
    );
    const votedDriver = [];
    for (const addr of jury) {
      const signer = signerMap[addr.toLowerCase()];
      const choiceIdx = votedDriver.length < 2 ? 1 : 2; // first 2 vote Driver, last votes Rider
      await dispute.connect(signer).vote(1, choiceIdx);
      if (choiceIdx === 1) votedDriver.push(addr);
    }

    await time.increase(VOTING_PERIOD);

    const balsBefore = {};
    for (const addr of jury) balsBefore[addr] = await token.balanceOf(addr);

    await dispute.executeCase(1);

    // Two winning jurors share 4 RIDE → 2 RIDE each
    const perJuror = JUROR_REWARD / 2n;
    for (const addr of votedDriver) {
      expect(await token.balanceOf(addr)).to.equal(balsBefore[addr] + perJuror);
    }
    expect(await dispute.rewardReserve()).to.equal(0n);
  });

  it("distributes the full juror reward when it is not evenly divisible", async function () {
    const reward = 10n;
    const { token, dispute, treasury, arb1, arb2, arb3 } = await deployFixture({ jurorReward: reward });

    await token.connect(treasury).approve(dispute.target, reward);
    await dispute.connect(treasury).fundRewardReserve(reward);
    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);

    await dispute.connect(arb1).vote(1, 1);
    await dispute.connect(arb2).vote(1, 1);
    await dispute.connect(arb3).vote(1, 1);

    await time.increase(VOTING_PERIOD);

    const arb1Before = await token.balanceOf(arb1.address);
    const arb2Before = await token.balanceOf(arb2.address);
    const arb3Before = await token.balanceOf(arb3.address);

    await dispute.executeCase(1);

    expect(await token.balanceOf(arb1.address)).to.equal(arb1Before + 4n);
    expect(await token.balanceOf(arb2.address)).to.equal(arb2Before + 3n);
    expect(await token.balanceOf(arb3.address)).to.equal(arb3Before + 3n);
    expect(await dispute.rewardReserve()).to.equal(0n);
  });

  it("skips rewards silently if reserve is insufficient", async function () {
    const { dispute, arb1, arb2, arb3 } = await deployFixture({ jurorReward: JUROR_REWARD });
    // No funds in reserve → rewardReserve = 0

    await dispute.connect(arb1).registerAsJuror();
    await dispute.connect(arb2).registerAsJuror();
    await dispute.connect(arb3).registerAsJuror();
    await dispute.openCaseWithRandomJury(1, 3);

    for (const arb of [arb1, arb2, arb3]) {
      await dispute.connect(arb).vote(1, 1); // all vote Driver
    }

    await time.increase(VOTING_PERIOD);

    // Should not revert even with no reserve
    await expect(dispute.executeCase(1)).not.to.be.reverted;
    expect(await dispute.rewardReserve()).to.equal(0n);
  });

  // ── Voting edge cases ─────────────────────────────────────────────────────

  it("rejects a vote after the voting window has closed", async function () {
    const { dispute, arb1, arb2, arb3 } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);
    await time.increase(VOTING_PERIOD);

    await expect(dispute.connect(arb1).vote(1, 1)).to.be.revertedWithCustomError(
      dispute, "VotingClosed"
    );
  });

  it("rejects executeCase before the voting window has closed", async function () {
    const { dispute, arb1, arb2, arb3 } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);
    await dispute.connect(arb1).vote(1, 1);

    await expect(dispute.executeCase(1)).to.be.revertedWithCustomError(dispute, "VotingStillOpen");
  });

  it("rejects executeCase with zero votes submitted", async function () {
    const { dispute, arb1, arb2, arb3 } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);
    await time.increase(VOTING_PERIOD);

    await expect(dispute.executeCase(1)).to.be.revertedWithCustomError(dispute, "NoVotesSubmitted");
  });

  it("rider wins when majority votes Rider", async function () {
    const { token, escrow, dispute, rider, arb1, arb2, arb3 } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);
    await dispute.connect(arb1).vote(1, 2); // Rider
    await dispute.connect(arb2).vote(1, 2); // Rider
    await dispute.connect(arb3).vote(1, 1); // Driver

    await time.increase(VOTING_PERIOD);
    const riderBefore = await token.balanceOf(rider.address);
    await dispute.executeCase(1);

    // Rider wins full 20 RIDE
    expect(await token.balanceOf(rider.address)).to.equal(riderBefore + ethers.parseEther("20"));
    expect((await escrow.rides(1)).status).to.equal(4);
  });

  it("split outcome distributes fare 50/50 when Split vote wins", async function () {
    const { token, escrow, dispute, rider, driver, arb1, arb2, arb3 } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);
    await dispute.connect(arb1).vote(1, 3); // Split
    await dispute.connect(arb2).vote(1, 3); // Split
    await dispute.connect(arb3).vote(1, 1); // Driver

    await time.increase(VOTING_PERIOD);
    const driverBefore = await token.balanceOf(driver.address);
    const riderBefore  = await token.balanceOf(rider.address);
    await dispute.executeCase(1);

    const fare = ethers.parseEther("20");
    const driverHalf = fare / 2n;
    const riderHalf  = fare - driverHalf;

    // Driver gets half minus 10% platform fee
    expect(await token.balanceOf(driver.address)).to.equal(
      driverBefore + (driverHalf * 9n) / 10n
    );
    expect(await token.balanceOf(rider.address)).to.equal(riderBefore + riderHalf);
    expect((await escrow.rides(1)).status).to.equal(4);
  });

  it("assigns the odd wei to the driver when a split outcome resolves an odd fare", async function () {
    const { token, escrow, dispute, matcher, rider, driver, arb1, arb2, arb3 } = await deployFixture();
    const oddFare = 1001n;

    await escrow.setPlatformFee(0);
    await escrow.connect(rider).requestRide(token.target, oddFare, metadataHash);
    await escrow.connect(matcher).matchRide(2, driver.address);
    await escrow.connect(driver).startRide(2);
    await escrow.connect(rider).disputeRide(2, evidenceHash);

    await dispute.openCase(2, [arb1.address, arb2.address, arb3.address]);
    await dispute.connect(arb1).vote(1, 3);
    await dispute.connect(arb2).vote(1, 3);
    await dispute.connect(arb3).vote(1, 1);

    await time.increase(VOTING_PERIOD);

    const driverBefore = await token.balanceOf(driver.address);
    const riderBefore = await token.balanceOf(rider.address);

    await dispute.executeCase(1);

    expect(await token.balanceOf(driver.address)).to.equal(driverBefore + 501n);
    expect(await token.balanceOf(rider.address)).to.equal(riderBefore + 500n);
  });

  it("driver wins a three-way tie (tie-break: driver > rider > split)", async function () {
    const { token, dispute, driver, arb1, arb2, arb3 } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);
    await dispute.connect(arb1).vote(1, 1); // Driver
    await dispute.connect(arb2).vote(1, 2); // Rider
    await dispute.connect(arb3).vote(1, 3); // Split  →  1 each, tie

    await time.increase(VOTING_PERIOD);
    const driverBefore = await token.balanceOf(driver.address);
    await dispute.executeCase(1);

    // Driver wins the tie (d >= r && d >= s → driver)
    expect(await token.balanceOf(driver.address)).to.equal(driverBefore + ethers.parseEther("18"));
  });

  it("prevents double execution of a case", async function () {
    const { dispute, arb1, arb2, arb3 } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);
    await dispute.connect(arb1).vote(1, 1);
    await time.increase(VOTING_PERIOD);
    await dispute.executeCase(1);

    await expect(dispute.executeCase(1)).to.be.revertedWithCustomError(dispute, "CaseAlreadyExecuted");
  });

  it("openCase admin path rejects unqualified jurors", async function () {
    const { dispute, outsider, arb1, arb2 } = await deployFixture();

    await expect(dispute.openCase(1, [outsider.address])).to.be.revertedWithCustomError(
      dispute, "ArbitratorNotQualified"
    );
    await expect(dispute.openCase(1, [])).to.be.revertedWithCustomError(
      dispute, "EmptyJury"
    );
  });

  // ── Setter coverage ───────────────────────────────────────────────────────

  it("setJurorRewardPerCase updates the reward amount", async function () {
    const { dispute } = await deployFixture();
    await dispute.setJurorRewardPerCase(ethers.parseEther("10"));
    expect(await dispute.jurorRewardPerCase()).to.equal(ethers.parseEther("10"));
  });

  it("setVotingPeriod updates the voting window", async function () {
    const { dispute } = await deployFixture();
    await dispute.setVotingPeriod(24 * 3600);
    expect(await dispute.votingPeriod()).to.equal(24 * 3600);
  });

  it("setMinimumArbitratorStake updates the stake floor", async function () {
    const { dispute } = await deployFixture();
    await dispute.setMinimumArbitratorStake(ethers.parseEther("100"));
    expect(await dispute.minimumArbitratorStake()).to.equal(ethers.parseEther("100"));
  });

  it("setTreasury rejects zero address", async function () {
    const { dispute } = await deployFixture();
    await expect(dispute.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      dispute, "ZeroAddress"
    );
  });

  it("setRideEscrow rejects zero address", async function () {
    const { dispute } = await deployFixture();
    await expect(dispute.setRideEscrow(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      dispute, "ZeroAddress"
    );
  });

  it("getCase reverts for an unknown caseId", async function () {
    const { dispute } = await deployFixture();
    await expect(dispute.getCase(999)).to.be.revertedWithCustomError(dispute, "CaseNotFound");
  });

  it("fundRewardReserve rejects zero amount", async function () {
    const { dispute } = await deployFixture();
    await expect(dispute.fundRewardReserve(0)).to.be.revertedWithCustomError(dispute, "ZeroAmount");
  });

  it("slashArbitrator rejects zero amount", async function () {
    const { dispute } = await deployFixture();
    await expect(dispute.slashArbitrator(ethers.ZeroAddress, 0, "bad")).to.be.revertedWithCustomError(
      dispute, "ZeroAmount"
    );
  });

  it("slashArbitrator rejects slash exceeding stake", async function () {
    const { dispute, arb1 } = await deployFixture();
    await expect(
      dispute.slashArbitrator(arb1.address, ethers.parseEther("1000"), "too much")
    ).to.be.revertedWithCustomError(dispute, "SlashExceedsStake");
  });

  it("unstake rejects amount exceeding stake", async function () {
    const { dispute, arb1 } = await deployFixture();
    await expect(
      dispute.connect(arb1).unstake(ethers.parseEther("1000"))
    ).to.be.revertedWithCustomError(dispute, "SlashExceedsStake");
  });

  it("openCase rejects non-disputed ride", async function () {
    const { dispute, escrow, arb1, arb2, arb3 } = await deployFixture();
    // rideId 999 doesn't exist, fareAmount = 0 → NotDisputedRide
    await expect(dispute.openCase(999, [arb1.address])).to.be.revertedWithCustomError(
      dispute, "NotDisputedRide"
    );
  });

  it("openCaseWithRandomJury rejects non-disputed ride", async function () {
    const { dispute, arb1 } = await deployFixture();
    await dispute.connect(arb1).registerAsJuror();

    await expect(dispute.openCaseWithRandomJury(999, 1)).to.be.revertedWithCustomError(
      dispute, "NotDisputedRide"
    );
  });

  it("vote rejects VoteChoice.None (0)", async function () {
    const { dispute, arb1, arb2, arb3 } = await deployFixture();
    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);
    await expect(dispute.connect(arb1).vote(1, 0)).to.be.revertedWithCustomError(
      dispute, "InvalidVoteChoice"
    );
  });

  it("removes a non-last pool member by swapping with the last (swap-and-pop branch)", async function () {
    const { dispute, arb1, arb2, arb3 } = await deployFixture();

    // Register all three so pool has 3 members: [arb1, arb2, arb3]
    await dispute.connect(arb1).registerAsJuror();
    await dispute.connect(arb2).registerAsJuror();
    await dispute.connect(arb3).registerAsJuror();
    expect(await dispute.eligiblePoolSize()).to.equal(3);

    // Deregister arb1 (index 0, not the last) → triggers swap: arb3 swaps into slot 0
    await dispute.connect(arb1).deregisterAsJuror();
    expect(await dispute.eligiblePoolSize()).to.equal(2);

    // arb1 should no longer be registered; arb2 and arb3 still are
    await expect(dispute.connect(arb1).deregisterAsJuror()).to.be.revertedWithCustomError(
      dispute, "NotRegistered"
    );
  });

  it("deregisterAsJuror rejects caller not in pool", async function () {
    const { dispute, outsider } = await deployFixture();
    await expect(dispute.connect(outsider).deregisterAsJuror()).to.be.revertedWithCustomError(
      dispute, "NotRegistered"
    );
  });

  it("openCase rejects a zero-address jury member", async function () {
    const { dispute, arb1 } = await deployFixture();
    await expect(dispute.openCase(1, [ethers.ZeroAddress])).to.be.revertedWithCustomError(
      dispute, "ZeroAddress"
    );
  });

  it("setTreasury accepts a valid address", async function () {
    const { dispute, outsider } = await deployFixture();
    await expect(dispute.setTreasury(outsider.address))
      .to.emit(dispute, "TreasuryUpdated")
      .withArgs(outsider.address);
    expect(await dispute.treasury()).to.equal(outsider.address);
  });

  it("setRideEscrow accepts a valid address", async function () {
    const { dispute, outsider } = await deployFixture();
    await expect(dispute.setRideEscrow(outsider.address))
      .to.emit(dispute, "RideEscrowUpdated")
      .withArgs(outsider.address);
    expect(await dispute.rideEscrow()).to.equal(outsider.address);
  });

  it("slashArbitrator also auto-deregisters from pool when stake drops below minimum", async function () {
    const { dispute, treasury, arb1 } = await deployFixture();

    await dispute.connect(arb1).registerAsJuror();
    expect(await dispute.eligiblePoolSize()).to.equal(1);

    // Slash enough to drop below MIN_ARB_STAKE (50 RIDE) → auto-deregister
    await dispute.slashArbitrator(arb1.address, ethers.parseEther("1"), "minor");
    expect(await dispute.eligiblePoolSize()).to.equal(0);
  });

  it("fundRewardReserve transfers RIDE into reserve", async function () {
    const { token, dispute, treasury } = await deployFixture();
    const amount = ethers.parseEther("20");

    await token.connect(treasury).approve(dispute.target, amount);
    await expect(dispute.connect(treasury).fundRewardReserve(amount))
      .to.emit(dispute, "RewardReserveFunded")
      .withArgs(amount, amount);

    expect(await dispute.rewardReserve()).to.equal(amount);
  });

  it("stake rejects zero amount", async function () {
    const { dispute, arb1 } = await deployFixture();
    await expect(dispute.connect(arb1).stake(0)).to.be.revertedWithCustomError(dispute, "ZeroAmount");
  });

  it("unstake rejects zero amount", async function () {
    const { dispute, arb1 } = await deployFixture();
    await expect(dispute.connect(arb1).unstake(0)).to.be.revertedWithCustomError(dispute, "ZeroAmount");
  });

  it("vote on an already-executed case reverts with CaseAlreadyExecuted", async function () {
    const { dispute, arb1, arb2, arb3 } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);
    await dispute.connect(arb1).vote(1, 1);
    await time.increase(VOTING_PERIOD);
    await dispute.executeCase(1);

    await expect(dispute.connect(arb2).vote(1, 1)).to.be.revertedWithCustomError(
      dispute, "CaseAlreadyExecuted"
    );
  });

  it("constructor rejects zero rideToken address", async function () {
    const [owner, treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);
    const Escrow = await ethers.getContractFactory("RideEscrow");
    const Dispute = await ethers.getContractFactory("DisputeResolution");

    await expect(
      Dispute.deploy(ethers.ZeroAddress, token.target, treasury.address, MIN_ARB_STAKE, VOTING_PERIOD, 0)
    ).to.be.revertedWithCustomError({ interface: Dispute.interface }, "ZeroAddress");
  });

  it("constructor rejects zero treasury address", async function () {
    const [owner, treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);
    const Dispute = await ethers.getContractFactory("DisputeResolution");

    await expect(
      Dispute.deploy(token.target, token.target, ethers.ZeroAddress, MIN_ARB_STAKE, VOTING_PERIOD, 0)
    ).to.be.revertedWithCustomError({ interface: Dispute.interface }, "ZeroAddress");
  });

  it("constructor rejects zero rideEscrow address", async function () {
    const [owner, treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);
    const Dispute = await ethers.getContractFactory("DisputeResolution");

    await expect(
      Dispute.deploy(token.target, ethers.ZeroAddress, treasury.address, MIN_ARB_STAKE, VOTING_PERIOD, 0)
    ).to.be.revertedWithCustomError({ interface: Dispute.interface }, "ZeroAddress");
  });

  it("unstake below minimum does not auto-deregister when not in the eligible pool", async function () {
    const { dispute, token, treasury, arb1 } = await deployFixture();

    // arb1 staked in fixture but did NOT register as juror → poolIndex == 0
    expect(await dispute.eligiblePoolSize()).to.equal(0);

    // Unstake 1 token → stake drops below minimum, but condition (stake < min && poolIndex != 0) is FALSE
    await dispute.connect(arb1).unstake(ethers.parseEther("1"));
    expect(await dispute.eligiblePoolSize()).to.equal(0); // pool unchanged
  });

  // ── Non-owner access control ───────────────────────────────────────────────

  it("openCase reverts for non-owner caller", async function () {
    const { dispute, outsider, arb1 } = await deployFixture();
    await expect(
      dispute.connect(outsider).openCase(1, [arb1.address])
    ).to.be.revertedWithCustomError(dispute, "OwnableUnauthorizedAccount");
  });

  it("openCaseWithRandomJury reverts for non-owner caller", async function () {
    const { dispute, outsider, arb1 } = await deployFixture();
    await dispute.connect(arb1).registerAsJuror();
    await expect(
      dispute.connect(outsider).openCaseWithRandomJury(1, 1)
    ).to.be.revertedWithCustomError(dispute, "OwnableUnauthorizedAccount");
  });

  it("slashArbitrator reverts for non-owner caller", async function () {
    const { dispute, outsider, arb1 } = await deployFixture();
    await expect(
      dispute.connect(outsider).slashArbitrator(arb1.address, ethers.parseEther("1"), "bad")
    ).to.be.revertedWithCustomError(dispute, "OwnableUnauthorizedAccount");
  });

  it("setRideEscrow reverts for non-owner caller", async function () {
    const { dispute, outsider } = await deployFixture();
    await expect(
      dispute.connect(outsider).setRideEscrow(outsider.address)
    ).to.be.revertedWithCustomError(dispute, "OwnableUnauthorizedAccount");
  });

  it("setTreasury reverts for non-owner caller", async function () {
    const { dispute, outsider } = await deployFixture();
    await expect(
      dispute.connect(outsider).setTreasury(outsider.address)
    ).to.be.revertedWithCustomError(dispute, "OwnableUnauthorizedAccount");
  });

  it("setMinimumArbitratorStake reverts for non-owner caller", async function () {
    const { dispute, outsider } = await deployFixture();
    await expect(
      dispute.connect(outsider).setMinimumArbitratorStake(ethers.parseEther("10"))
    ).to.be.revertedWithCustomError(dispute, "OwnableUnauthorizedAccount");
  });

  it("setVotingPeriod reverts for non-owner caller", async function () {
    const { dispute, outsider } = await deployFixture();
    await expect(
      dispute.connect(outsider).setVotingPeriod(24 * 3600)
    ).to.be.revertedWithCustomError(dispute, "OwnableUnauthorizedAccount");
  });

  it("setJurorRewardPerCase reverts for non-owner caller", async function () {
    const { dispute, outsider } = await deployFixture();
    await expect(
      dispute.connect(outsider).setJurorRewardPerCase(ethers.parseEther("5"))
    ).to.be.revertedWithCustomError(dispute, "OwnableUnauthorizedAccount");
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const metadataHash = ethers.id("ride:dispute-case");
const evidenceHash = ethers.id("ipfs:dispute-evidence");

describe("DisputeResolution", function () {
  async function deployFixture() {
    const [treasury, matcher, tempResolver, rider, driver, arb1, arb2, arb3, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);

    const minimumDriverStake = ethers.parseEther("100");
    const Staking = await ethers.getContractFactory("DriverStaking");
    const staking = await Staking.deploy(token.target, treasury.address, minimumDriverStake, 0);

    const Escrow = await ethers.getContractFactory("RideEscrow");
    const escrow = await Escrow.deploy(
      staking.target,
      treasury.address,
      matcher.address,
      tempResolver.address,
      1_000,
      900
    );

    const minimumArbStake = ethers.parseEther("50");
    const votingPeriod = 48 * 60 * 60;
    const Dispute = await ethers.getContractFactory("DisputeResolution");
    const dispute = await Dispute.deploy(token.target, escrow.target, treasury.address, minimumArbStake, votingPeriod);
    await escrow.connect(treasury).setDisputeResolver(dispute.target);

    await token.connect(treasury).setTransferLimitExempt(escrow.target, true);
    await token.connect(treasury).setTransferLimitExempt(dispute.target, true);
    await token.connect(treasury).transfer(rider.address, ethers.parseEther("100"));
    await token.connect(treasury).transfer(driver.address, minimumDriverStake);

    for (const arb of [arb1, arb2, arb3]) {
      await token.connect(treasury).transfer(arb.address, minimumArbStake);
      await token.connect(arb).approve(dispute.target, minimumArbStake);
      await dispute.connect(arb).stake(minimumArbStake);
    }

    await token.connect(driver).approve(staking.target, minimumDriverStake);
    await staking.connect(driver).stake(minimumDriverStake);
    await token.connect(rider).approve(escrow.target, ethers.MaxUint256);

    await escrow.connect(rider).requestRide(token.target, ethers.parseEther("20"), metadataHash);
    await escrow.connect(matcher).matchRide(1, driver.address);
    await escrow.connect(driver).startRide(1);
    await escrow.connect(rider).disputeRide(1, evidenceHash);

    return { token, escrow, dispute, treasury, rider, driver, arb1, arb2, arb3, outsider, votingPeriod };
  }

  it("opens a case only for a disputed ride with qualified jurors", async function () {
    const { dispute, arb1, arb2, arb3 } = await deployFixture();

    await expect(dispute.openCase(1, [arb1.address, arb2.address, arb3.address]))
      .to.emit(dispute, "CaseOpened")
      .withArgs(1, 1, [arb1.address, arb2.address, arb3.address]);

    const caseData = await dispute.getCase(1);
    expect(caseData.rideId).to.equal(1);
    expect(caseData.jury).to.deep.equal([arb1.address, arb2.address, arb3.address]);
  });

  it("executes the majority outcome through ride escrow", async function () {
    const { token, escrow, dispute, driver, arb1, arb2, arb3, votingPeriod } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);
    await dispute.connect(arb1).vote(1, 1);
    await dispute.connect(arb2).vote(1, 1);
    await dispute.connect(arb3).vote(1, 2);

    await time.increase(votingPeriod);

    const driverBefore = await token.balanceOf(driver.address);
    await dispute.executeCase(1);

    expect(await token.balanceOf(driver.address)).to.equal(driverBefore + ethers.parseEther("18"));
    expect((await escrow.rides(1)).status).to.equal(4);
    expect((await dispute.getCase(1)).executed).to.equal(true);
  });

  it("rejects non-juror votes and duplicate votes", async function () {
    const { dispute, arb1, arb2, arb3, outsider } = await deployFixture();

    await dispute.openCase(1, [arb1.address, arb2.address, arb3.address]);

    await expect(dispute.connect(outsider).vote(1, 1)).to.be.revertedWithCustomError(dispute, "NotSelectedJuror");
    await dispute.connect(arb1).vote(1, 3);
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
});

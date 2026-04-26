const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("VestingWalletFactory", function () {
  async function deployFixture() {
    const [owner, beneficiary, other] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(owner.address);

    const Factory = await ethers.getContractFactory("VestingWalletFactory");
    const factory = await Factory.deploy(owner.address);

    return { token, factory, owner, beneficiary, other };
  }

  it("creates a vesting wallet with the specified parameters", async function () {
    const { factory, beneficiary } = await deployFixture();
    const start    = BigInt(await time.latest()) + 60n;
    const duration = 365n * 24n * 60n * 60n; // 1 year

    const tx = await factory.createVesting(beneficiary.address, start, duration, "Team");
    const receipt = await tx.wait();

    const event = receipt.logs.find(l => {
      try { factory.interface.parseLog(l); return true; } catch { return false; }
    });
    expect(event).to.not.be.undefined;

    expect(await factory.walletCount()).to.equal(1);
    const walletAddr = await factory.wallets(0);
    expect(walletAddr).to.not.equal(ethers.ZeroAddress);
  });

  it("emits VestingCreated with all fields", async function () {
    const { factory, beneficiary } = await deployFixture();
    const start    = BigInt(await time.latest()) + 60n;
    const duration = 90n * 24n * 60n * 60n;

    await expect(factory.createVesting(beneficiary.address, start, duration, "Investor"))
      .to.emit(factory, "VestingCreated")
      .withArgs(0, (val) => val !== ethers.ZeroAddress, beneficiary.address, start, duration, "Investor");
  });

  it("deployed wallet label matches the factory label", async function () {
    const { factory, beneficiary } = await deployFixture();
    const start    = BigInt(await time.latest()) + 100n;
    const duration = 180n * 24n * 60n * 60n;

    const tx = await factory.createVesting(beneficiary.address, start, duration, "Ecosystem");
    const receipt = await tx.wait();

    // Find created wallet address from event
    let walletAddr;
    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed.name === "VestingCreated") {
          walletAddr = parsed.args[1];
          break;
        }
      } catch {}
    }

    const wallet = await ethers.getContractAt("DecrideVestingWallet", walletAddr);
    expect(await wallet.label()).to.equal("Ecosystem");
    expect(await wallet.owner()).to.equal(beneficiary.address);
  });

  it("releases vested RIDE tokens to beneficiary after vesting period", async function () {
    const { token, factory, owner, beneficiary } = await deployFixture();

    // Exempt the factory from RIDE transfer limits so it can receive tokens for funding
    await token.connect(owner).setTransferLimitExempt(factory.target, true);

    const now      = BigInt(await time.latest());
    const start    = now + 10n;
    const duration = 365n * 24n * 60n * 60n;
    const allocation = ethers.parseEther("1000");

    const tx = await factory.createVesting(beneficiary.address, start, duration, "Team");
    const receipt = await tx.wait();
    let walletAddr;
    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed.name === "VestingCreated") { walletAddr = parsed.args[1]; break; }
      } catch {}
    }

    // Fund the wallet directly (treasury → wallet)
    await token.connect(owner).transfer(walletAddr, allocation);
    expect(await token.balanceOf(walletAddr)).to.equal(allocation);

    // Fast-forward past the full vesting duration
    await time.increase(Number(start - now) + Number(duration) + 1);

    const beneficiaryBefore = await token.balanceOf(beneficiary.address);
    const wallet = await ethers.getContractAt("DecrideVestingWallet", walletAddr);

    await wallet["release(address)"](token.target);

    const released = await token.balanceOf(beneficiary.address) - beneficiaryBefore;
    expect(released).to.be.closeTo(allocation, ethers.parseEther("0.001"));
  });

  it("only releases what has vested at a mid-point", async function () {
    const { token, factory, owner, beneficiary } = await deployFixture();

    const now      = BigInt(await time.latest());
    const start    = now + 10n;
    const duration = 1000n; // 1000 seconds
    const allocation = ethers.parseEther("1000");

    const tx = await factory.createVesting(beneficiary.address, start, duration, "Test");
    const receipt = await tx.wait();
    let walletAddr;
    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed.name === "VestingCreated") { walletAddr = parsed.args[1]; break; }
      } catch {}
    }

    await token.connect(owner).transfer(walletAddr, allocation);
    await time.increase(Number(start - now) + 500); // half-way through vesting

    const wallet = await ethers.getContractAt("DecrideVestingWallet", walletAddr);
    await wallet["release(address)"](token.target);

    const released = await token.balanceOf(beneficiary.address);
    // Should be approximately 50% of allocation (±10 RIDE tolerance for block-time variance)
    expect(released).to.be.closeTo(allocation / 2n, ethers.parseEther("10"));
  });

  it("rejects createVesting with zero-address beneficiary", async function () {
    const { factory } = await deployFixture();
    const start = BigInt(await time.latest()) + 60n;

    await expect(
      factory.createVesting(ethers.ZeroAddress, start, 3600n, "Bad")
    ).to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  it("rejects createVesting with zero duration", async function () {
    const { factory, beneficiary } = await deployFixture();
    const start = BigInt(await time.latest()) + 60n;

    await expect(
      factory.createVesting(beneficiary.address, start, 0n, "Bad")
    ).to.be.revertedWithCustomError(factory, "ZeroDuration");
  });

  it("only owner can create vesting wallets", async function () {
    const { factory, beneficiary, other } = await deployFixture();
    const start = BigInt(await time.latest()) + 60n;

    await expect(
      factory.connect(other).createVesting(beneficiary.address, start, 3600n, "Bad")
    ).to.be.reverted;
  });

  it("increments walletCount for each created wallet", async function () {
    const { factory, beneficiary } = await deployFixture();
    const start = BigInt(await time.latest()) + 60n;

    await factory.createVesting(beneficiary.address, start, 3600n, "A");
    await factory.createVesting(beneficiary.address, start, 7200n, "B");
    await factory.createVesting(beneficiary.address, start, 86400n, "C");

    expect(await factory.walletCount()).to.equal(3);
  });
});

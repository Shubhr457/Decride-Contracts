const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RIDEToken", function () {
  async function deployTokenFixture() {
    const [treasury, alice, bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);

    return { token, treasury, alice, bob };
  }

  it("mints the fixed supply to the treasury", async function () {
    const { token, treasury } = await deployTokenFixture();

    expect(await token.totalSupply()).to.equal(ethers.parseEther("1000000000"));
    expect(await token.balanceOf(treasury.address)).to.equal(await token.totalSupply());
    expect(await token.owner()).to.equal(treasury.address);
  });

  it("enforces the 2 percent launch transfer limit between non-exempt accounts", async function () {
    const { token, treasury, alice, bob } = await deployTokenFixture();
    const limit = await token.maxTransferAmount();

    await token.connect(treasury).transfer(alice.address, limit + 1n);

    await expect(token.connect(alice).transfer(bob.address, limit + 1n))
      .to.be.revertedWithCustomError(token, "TransferExceedsLaunchLimit")
      .withArgs(limit + 1n, limit);

    await expect(token.connect(alice).transfer(bob.address, limit)).to.changeTokenBalances(
      token, [alice, bob], [-limit, limit]
    );
  });

  it("lets the owner update transfer limits and exemptions", async function () {
    const { token, treasury, alice, bob } = await deployTokenFixture();
    const amount = ethers.parseEther("30000000");

    await token.connect(treasury).transfer(alice.address, amount);
    await token.connect(treasury).setTransferLimitExempt(alice.address, true);

    await expect(token.connect(alice).transfer(bob.address, amount)).to.changeTokenBalances(
      token, [alice, bob], [-amount, amount]
    );

    await token.connect(treasury).setTransferLimit(0, false);
    expect(await token.transferLimitEnabled()).to.equal(false);
  });

  it("supports governance vote delegation", async function () {
    const { token, treasury, alice } = await deployTokenFixture();
    const amount = ethers.parseEther("100");

    await token.connect(treasury).transfer(alice.address, amount);
    await token.connect(alice).delegate(alice.address);

    expect(await token.getVotes(alice.address)).to.equal(amount);
  });

  it("vesting wallets and operational contracts can be exempted", async function () {
    const { token, treasury, alice, bob } = await deployTokenFixture();
    const amount = ethers.parseEther("30000000"); // > 2% limit

    // Simulate vesting wallet: exempt the "wallet" address
    await token.connect(treasury).setTransferLimitExempt(alice.address, true);
    await token.connect(treasury).transfer(alice.address, amount);

    // Wallet releases tokens to beneficiary (bob is not exempt, amount stays below limit)
    const smallRelease = ethers.parseEther("1000");
    await expect(token.connect(alice).transfer(bob.address, smallRelease)).not.to.be.reverted;
  });

  it("setTransferLimit rejects limit above BPS_DENOMINATOR", async function () {
    const { token, treasury } = await deployTokenFixture();
    await expect(
      token.connect(treasury).setTransferLimit(10_001, true)
    ).to.be.revertedWithCustomError(token, "TransferLimitTooHigh");
  });

  it("nonces returns the expected permit nonce for an account", async function () {
    const { token, alice } = await deployTokenFixture();
    expect(await token.nonces(alice.address)).to.equal(0);
  });

  it("transfer to an exempt recipient bypasses the limit check regardless of amount", async function () {
    const { token, treasury, alice, bob } = await deployTokenFixture();
    const overLimit = await token.maxTransferAmount() + 1n;

    // Make bob exempt (simulates receiving vesting wallet)
    await token.connect(treasury).setTransferLimitExempt(bob.address, true);
    // Give alice a large balance (via treasury which is already exempt)
    await token.connect(treasury).transfer(alice.address, overLimit);

    // alice → bob (over limit); alice not exempt, but bob is exempt → limit bypassed
    await expect(token.connect(alice).transfer(bob.address, overLimit)).not.to.be.reverted;
  });

  // ── Non-owner access control ───────────────────────────────────────────────

  it("setTransferLimit reverts for non-owner caller", async function () {
    const { token, alice } = await deployTokenFixture();
    await expect(
      token.connect(alice).setTransferLimit(100, true)
    ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
  });

  it("setTransferLimitExempt reverts for non-owner caller", async function () {
    const { token, alice, bob } = await deployTokenFixture();
    await expect(
      token.connect(alice).setTransferLimitExempt(bob.address, true)
    ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
  });
});

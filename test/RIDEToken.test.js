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
      token,
      [alice, bob],
      [-limit, limit]
    );
  });

  it("lets the owner update transfer limits and exemptions", async function () {
    const { token, treasury, alice, bob } = await deployTokenFixture();
    const amount = ethers.parseEther("30000000");

    await token.connect(treasury).transfer(alice.address, amount);
    await token.connect(treasury).setTransferLimitExempt(alice.address, true);

    await expect(token.connect(alice).transfer(bob.address, amount)).to.changeTokenBalances(
      token,
      [alice, bob],
      [-amount, amount]
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
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("DriverStaking", function () {
  async function deployFixture() {
    const [treasury, driver, slasher, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);

    const minimumStake = ethers.parseEther("100");
    const cooldown = 7 * 24 * 60 * 60;
    const Staking = await ethers.getContractFactory("DriverStaking");
    const staking = await Staking.deploy(token.target, treasury.address, minimumStake, cooldown);

    await token.connect(treasury).transfer(driver.address, ethers.parseEther("500"));
    await token.connect(driver).approve(staking.target, ethers.MaxUint256);

    return { token, staking, treasury, driver, slasher, outsider, minimumStake, cooldown };
  }

  it("activates a driver after the minimum collateral is staked", async function () {
    const { staking, driver, minimumStake } = await deployFixture();

    await expect(staking.connect(driver).stake(minimumStake))
      .to.emit(staking, "Staked")
      .withArgs(driver.address, minimumStake, minimumStake);

    expect(await staking.isDriverActive(driver.address)).to.equal(true);
  });

  it("requires the cooldown before unstaking", async function () {
    const { token, staking, driver, minimumStake, cooldown } = await deployFixture();

    await staking.connect(driver).stake(minimumStake);
    await staking.connect(driver).requestUnstake();

    await expect(staking.connect(driver).completeUnstake()).to.be.revertedWithCustomError(
      staking,
      "CooldownNotFinished"
    );

    await time.increase(cooldown);

    await expect(staking.connect(driver).completeUnstake()).to.changeTokenBalances(
      token,
      [staking, driver],
      [-minimumStake, minimumStake]
    );

    expect(await staking.isDriverActive(driver.address)).to.equal(false);
  });

  it("allows configured slashers to slash collateral to the treasury", async function () {
    const { token, staking, treasury, driver, slasher, minimumStake } = await deployFixture();
    const slashAmount = ethers.parseEther("25");

    await staking.connect(driver).stake(minimumStake);
    await staking.connect(treasury).setSlasher(slasher.address, true);

    await expect(staking.connect(slasher).slash(driver.address, slashAmount, "fraud"))
      .to.emit(staking, "DriverSlashed")
      .withArgs(driver.address, slasher.address, slashAmount, "fraud");

    expect(await token.balanceOf(treasury.address)).to.equal(ethers.parseEther("999999525"));
  });

  it("rejects unauthorized slashing", async function () {
    const { staking, driver, outsider, minimumStake } = await deployFixture();

    await staking.connect(driver).stake(minimumStake);

    await expect(
      staking.connect(outsider).slash(driver.address, ethers.parseEther("1"), "bad")
    ).to.be.revertedWithCustomError(staking, "NotAuthorizedSlasher");
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PRICE_E18     = ethers.parseEther("1");   // $1.00 per RIDE
const MIN_STAKE_USD = ethers.parseEther("100"); // $100 → 100 RIDE required at $1/RIDE

describe("DriverStaking", function () {
  async function deployFixture() {
    const [treasury, driver, slasher, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);

    const Oracle = await ethers.getContractFactory("ManualRideUsdOracle");
    const oracle = await Oracle.deploy(treasury.address, PRICE_E18);

    const cooldown = 7 * 24 * 60 * 60;
    const Staking  = await ethers.getContractFactory("DriverStaking");
    const staking  = await Staking.deploy(
      token.target, oracle.target, treasury.address, MIN_STAKE_USD, cooldown
    );

    // Exempt staking from launch transfer limits so drivers can move large stake amounts
    await token.connect(treasury).setTransferLimitExempt(staking.target, true);
    await token.connect(treasury).transfer(driver.address, ethers.parseEther("500"));
    await token.connect(driver).approve(staking.target, ethers.MaxUint256);

    return { token, staking, oracle, treasury, driver, slasher, outsider, cooldown };
  }

  // ── Existing coverage ─────────────────────────────────────────────────────

  it("activates a driver after the minimum collateral is staked", async function () {
    const { staking, driver } = await deployFixture();
    const required = await staking.requiredRideStakeAmount();

    await expect(staking.connect(driver).stake(required))
      .to.emit(staking, "Staked")
      .withArgs(driver.address, required, required);

    expect(await staking.isDriverActive(driver.address)).to.equal(true);
  });

  it("requires the cooldown before unstaking", async function () {
    const { token, staking, driver, cooldown } = await deployFixture();
    const required = await staking.requiredRideStakeAmount();

    await staking.connect(driver).stake(required);
    await staking.connect(driver).requestUnstake();

    await expect(staking.connect(driver).completeUnstake()).to.be.revertedWithCustomError(
      staking, "CooldownNotFinished"
    );

    await time.increase(cooldown);

    await expect(staking.connect(driver).completeUnstake()).to.changeTokenBalances(
      token, [staking, driver], [-required, required]
    );

    expect(await staking.isDriverActive(driver.address)).to.equal(false);
  });

  it("allows configured slashers to slash collateral to the treasury", async function () {
    const { token, staking, treasury, driver, slasher } = await deployFixture();
    const required    = await staking.requiredRideStakeAmount();
    const slashAmount = ethers.parseEther("25");

    await staking.connect(driver).stake(required);
    await staking.connect(treasury).setSlasher(slasher.address, true);

    const treasuryBefore = await token.balanceOf(treasury.address);

    await expect(staking.connect(slasher).slash(driver.address, slashAmount, "fraud"))
      .to.emit(staking, "DriverSlashed")
      .withArgs(driver.address, slasher.address, slashAmount, "fraud");

    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + slashAmount);
  });

  it("rejects unauthorized slashing", async function () {
    const { staking, driver, outsider } = await deployFixture();
    const required = await staking.requiredRideStakeAmount();

    await staking.connect(driver).stake(required);

    await expect(
      staking.connect(outsider).slash(driver.address, ethers.parseEther("1"), "bad")
    ).to.be.revertedWithCustomError(staking, "NotAuthorizedSlasher");
  });

  // ── USD oracle pricing ────────────────────────────────────────────────────

  it("requiredRideStakeAmount reflects USD minimum divided by oracle price", async function () {
    const { staking, oracle, treasury } = await deployFixture();

    // At $1/RIDE, $100 USD → 100 RIDE
    expect(await staking.requiredRideStakeAmount()).to.equal(ethers.parseEther("100"));

    // At $2/RIDE, $100 USD → 50 RIDE
    await oracle.connect(treasury).setPrice(ethers.parseEther("2"));
    expect(await staking.requiredRideStakeAmount()).to.equal(ethers.parseEther("50"));

    // At $0.50/RIDE, $100 USD → 200 RIDE
    await oracle.connect(treasury).setPrice(ethers.parseEther("0.5"));
    expect(await staking.requiredRideStakeAmount()).to.equal(ethers.parseEther("200"));
  });

  it("deactivates a driver when price drops and their stake no longer meets USD minimum", async function () {
    const { staking, oracle, driver, treasury } = await deployFixture();
    const required = await staking.requiredRideStakeAmount(); // 100 RIDE at $1/RIDE

    await staking.connect(driver).stake(required);
    expect(await staking.isDriverActive(driver.address)).to.equal(true);

    // Price drops to $0.50 → now need 200 RIDE, driver only has 100
    await oracle.connect(treasury).setPrice(ethers.parseEther("0.5"));
    expect(await staking.isDriverActive(driver.address)).to.equal(false);

    // Driver tops up → active again
    await staking.connect(driver).stake(required); // now has 200 RIDE
    expect(await staking.isDriverActive(driver.address)).to.equal(true);
  });

  it("setMinimumStakeUsd updates the USD threshold", async function () {
    const { staking, treasury } = await deployFixture();
    const newMin = ethers.parseEther("200");

    await expect(staking.connect(treasury).setMinimumStakeUsd(newMin))
      .to.emit(staking, "MinimumStakeUsdUpdated")
      .withArgs(newMin);

    expect(await staking.minimumStakeUsdE18()).to.equal(newMin);
    // At $1/RIDE, $200 USD → 200 RIDE required
    expect(await staking.requiredRideStakeAmount()).to.equal(ethers.parseEther("200"));
  });

  it("setOracle updates the price feed", async function () {
    const { staking, treasury } = await deployFixture();

    const Oracle2 = await ethers.getContractFactory("ManualRideUsdOracle");
    const oracle2 = await Oracle2.deploy(treasury.address, ethers.parseEther("5")); // $5/RIDE

    await expect(staking.connect(treasury).setOracle(oracle2.target))
      .to.emit(staking, "OracleUpdated")
      .withArgs(oracle2.target);

    // $100 USD / $5 RIDE = 20 RIDE required
    expect(await staking.requiredRideStakeAmount()).to.equal(ethers.parseEther("20"));
  });

  it("slash that reduces stake below threshold deactivates the driver", async function () {
    const { staking, treasury, driver } = await deployFixture();
    const required = await staking.requiredRideStakeAmount(); // 100 RIDE

    await staking.connect(driver).stake(required);
    expect(await staking.isDriverActive(driver.address)).to.equal(true);

    // Slash 1 RIDE → 99 < 100 required → deactivated
    await staking.connect(treasury).slash(driver.address, ethers.parseEther("1"), "penalty");
    expect(await staking.isDriverActive(driver.address)).to.equal(false);
  });

  it("rejects unstake if driver is not active", async function () {
    const { staking, driver } = await deployFixture();
    await expect(staking.connect(driver).requestUnstake()).to.be.revertedWithCustomError(
      staking, "NotActiveDriver"
    );
  });

  // ── Setter zero-address guards ────────────────────────────────────────────

  it("setTreasury rejects zero address", async function () {
    const { staking } = await deployFixture();
    await expect(staking.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      staking, "ZeroAddress"
    );
  });

  it("setOracle rejects zero address", async function () {
    const { staking } = await deployFixture();
    await expect(staking.setOracle(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      staking, "ZeroAddress"
    );
  });

  // ── Partial staking paths ────────────────────────────────────────────────

  it("partial stake below threshold does not activate the driver", async function () {
    const { staking, driver } = await deployFixture();
    const required = await staking.requiredRideStakeAmount();

    // Stake only half the required amount
    await staking.connect(driver).stake(required / 2n);
    expect(await staking.isDriverActive(driver.address)).to.equal(false);

    // Top up to meet threshold → activated
    await staking.connect(driver).stake(required / 2n);
    expect(await staking.isDriverActive(driver.address)).to.equal(true);
  });

  it("slash that leaves stake above threshold does not deactivate the driver", async function () {
    const { staking, treasury, driver } = await deployFixture();
    const required = await staking.requiredRideStakeAmount();

    // Stake 2x required → 200 RIDE
    await staking.connect(driver).stake(required * 2n);
    expect(await staking.isDriverActive(driver.address)).to.equal(true);

    // Slash half → 100 RIDE remaining, still at required threshold
    await staking.connect(treasury).slash(driver.address, required, "minor penalty");
    expect(await staking.isDriverActive(driver.address)).to.equal(true);
  });

  it("completeUnstake rejects if cooldown was never started", async function () {
    const { staking, driver } = await deployFixture();
    const required = await staking.requiredRideStakeAmount();

    await staking.connect(driver).stake(required);

    await expect(staking.connect(driver).completeUnstake()).to.be.revertedWithCustomError(
      staking, "CooldownNotStarted"
    );
  });

  it("slash rejects zero amount", async function () {
    const { staking, driver, treasury } = await deployFixture();
    const required = await staking.requiredRideStakeAmount();
    await staking.connect(driver).stake(required);

    await expect(
      staking.connect(treasury).slash(driver.address, 0, "none")
    ).to.be.revertedWithCustomError(staking, "ZeroAmount");
  });

  it("slash rejects amount exceeding stake", async function () {
    const { staking, driver, treasury } = await deployFixture();
    const required = await staking.requiredRideStakeAmount();
    await staking.connect(driver).stake(required);

    await expect(
      staking.connect(treasury).slash(driver.address, required * 2n, "too much")
    ).to.be.revertedWithCustomError(staking, "SlashExceedsStake");
  });

  it("stake rejects zero amount", async function () {
    const { staking, driver } = await deployFixture();
    await expect(staking.connect(driver).stake(0)).to.be.revertedWithCustomError(staking, "ZeroAmount");
  });

  it("owner can update unstake cooldown", async function () {
    const { staking } = await deployFixture();
    await staking.setUnstakeCooldown(14 * 24 * 60 * 60);
    expect(await staking.unstakeCooldown()).to.equal(14 * 24 * 60 * 60);
  });

  it("setTreasury accepts a valid address", async function () {
    const { staking, treasury, outsider } = await deployFixture();
    await expect(staking.connect(treasury).setTreasury(outsider.address))
      .to.emit(staking, "TreasuryUpdated")
      .withArgs(outsider.address);
    expect(await staking.treasury()).to.equal(outsider.address);
  });

  it("constructor rejects zero rideToken address", async function () {
    const [treasury] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("ManualRideUsdOracle");
    const oracle = await Oracle.deploy(treasury.address, PRICE_E18);
    const Staking = await ethers.getContractFactory("DriverStaking");

    await expect(
      Staking.deploy(ethers.ZeroAddress, oracle.target, treasury.address, MIN_STAKE_USD, 0)
    ).to.be.revertedWithCustomError({ interface: Staking.interface }, "ZeroAddress");
  });

  it("constructor rejects zero oracle address", async function () {
    const [treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);
    const Staking = await ethers.getContractFactory("DriverStaking");

    await expect(
      Staking.deploy(token.target, ethers.ZeroAddress, treasury.address, MIN_STAKE_USD, 0)
    ).to.be.revertedWithCustomError({ interface: Staking.interface }, "ZeroAddress");
  });

  it("constructor rejects zero treasury address", async function () {
    const [deployer, treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);
    const Oracle = await ethers.getContractFactory("ManualRideUsdOracle");
    const oracle = await Oracle.deploy(deployer.address, PRICE_E18);
    const Staking = await ethers.getContractFactory("DriverStaking");

    await expect(
      Staking.deploy(token.target, oracle.target, ethers.ZeroAddress, MIN_STAKE_USD, 0)
    ).to.be.revertedWithCustomError({ interface: Staking.interface }, "ZeroAddress");
  });

  it("staking additional RIDE to an already-active driver keeps them active", async function () {
    const { staking, driver } = await deployFixture();
    const required = await staking.requiredRideStakeAmount();

    // First stake → activates
    await staking.connect(driver).stake(required);
    expect(await staking.isDriverActive(driver.address)).to.equal(true);

    // Second stake → already active (activatedAt != 0 short-circuit in stake())
    await staking.connect(driver).stake(required);
    expect(await staking.isDriverActive(driver.address)).to.equal(true);

    const info = await staking.driverStakes(driver.address);
    expect(info.amount).to.equal(required * 2n);
  });

  // ── Non-owner access control ───────────────────────────────────────────────

  it("setMinimumStakeUsd reverts for non-owner caller", async function () {
    const { staking, outsider } = await deployFixture();
    await expect(
      staking.connect(outsider).setMinimumStakeUsd(ethers.parseEther("200"))
    ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
  });

  it("setUnstakeCooldown reverts for non-owner caller", async function () {
    const { staking, outsider } = await deployFixture();
    await expect(
      staking.connect(outsider).setUnstakeCooldown(14 * 24 * 60 * 60)
    ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
  });

  it("setTreasury reverts for non-owner caller", async function () {
    const { staking, outsider } = await deployFixture();
    await expect(
      staking.connect(outsider).setTreasury(outsider.address)
    ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
  });

  it("setOracle reverts for non-owner caller", async function () {
    const { staking, oracle, outsider } = await deployFixture();
    await expect(
      staking.connect(outsider).setOracle(oracle.target)
    ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
  });

  it("setSlasher reverts for non-owner caller", async function () {
    const { staking, outsider } = await deployFixture();
    await expect(
      staking.connect(outsider).setSlasher(outsider.address, true)
    ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
  });
});

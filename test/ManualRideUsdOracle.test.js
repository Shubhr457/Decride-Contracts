const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ManualRideUsdOracle", function () {
  async function deployFixture() {
    const [owner, other] = await ethers.getSigners();
    const initialPrice = ethers.parseEther("0.1"); // $0.10 per RIDE
    const Oracle = await ethers.getContractFactory("ManualRideUsdOracle");
    const oracle = await Oracle.deploy(owner.address, initialPrice);
    return { oracle, owner, other, initialPrice };
  }

  it("stores and returns the initial price", async function () {
    const { oracle, initialPrice } = await deployFixture();
    expect(await oracle.latestPrice()).to.equal(initialPrice);
  });

  it("owner can update the price and emits PriceUpdated", async function () {
    const { oracle, owner, initialPrice } = await deployFixture();
    const newPrice = ethers.parseEther("1"); // $1.00

    await expect(oracle.connect(owner).setPrice(newPrice))
      .to.emit(oracle, "PriceUpdated")
      .withArgs(initialPrice, newPrice);

    expect(await oracle.latestPrice()).to.equal(newPrice);
  });

  it("rejects a price below MIN_PRICE_E18", async function () {
    const { oracle, owner } = await deployFixture();
    const minPrice = await oracle.MIN_PRICE_E18();

    await expect(oracle.connect(owner).setPrice(minPrice - 1n)).to.be.revertedWithCustomError(
      oracle, "PriceTooLow"
    );
    await expect(oracle.connect(owner).setPrice(0)).to.be.revertedWithCustomError(
      oracle, "PriceTooLow"
    );
  });

  it("rejects setPrice from a non-owner", async function () {
    const { oracle, other } = await deployFixture();

    await expect(oracle.connect(other).setPrice(ethers.parseEther("2"))).to.be.reverted;
  });

  it("accepts exactly MIN_PRICE_E18 as a valid price", async function () {
    const { oracle, owner } = await deployFixture();
    const minPrice = await oracle.MIN_PRICE_E18();

    await expect(oracle.connect(owner).setPrice(minPrice)).not.to.be.reverted;
    expect(await oracle.latestPrice()).to.equal(minPrice);
  });

  it("constructor rejects zero owner address", async function () {
    const Oracle = await ethers.getContractFactory("ManualRideUsdOracle");
    // OZ Ownable v5 rejects address(0) with OwnableInvalidOwner before the body runs
    await expect(
      Oracle.deploy(ethers.ZeroAddress, ethers.parseEther("1"))
    ).to.be.reverted;
  });

  it("constructor rejects price below minimum", async function () {
    const [owner] = await ethers.getSigners();
    const Oracle  = await ethers.getContractFactory("ManualRideUsdOracle");
    await expect(
      Oracle.deploy(owner.address, 0n)
    ).to.be.revertedWithCustomError({ interface: Oracle.interface }, "PriceTooLow");
  });
});

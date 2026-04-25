const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DAOGovernor", function () {
  it("configures token voting, quorum, and timelock execution", async function () {
    const [deployer, treasury] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("RIDEToken");
    const token = await Token.deploy(treasury.address);

    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(48 * 60 * 60, [], [ethers.ZeroAddress], deployer.address);

    const Governor = await ethers.getContractFactory("DAOGovernor");
    const governor = await Governor.deploy(token.target, timelock.target);

    expect(await governor.name()).to.equal("Decride DAO");
    expect(await governor.votingDelay()).to.equal(7 * 24 * 60 * 60);
    expect(await governor.votingPeriod()).to.equal(14 * 24 * 60 * 60);
    expect(await governor.quorumNumerator()).to.equal(4);
    expect(await governor.timelock()).to.equal(timelock.target);
  });
});

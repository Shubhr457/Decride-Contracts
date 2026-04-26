// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRideUsdOracle} from "../oracle/IRideUsdOracle.sol";

/// @title Driver collateral staking for Decride.
/// @notice Drivers become active by staking RIDE tokens worth at least minimumStakeUsdE18 USD.
///         The required RIDE amount is recalculated on every activation check via the oracle,
///         so a price drop that brings a driver below the USD floor deactivates them until they
///         top up their stake. Slashed amounts go to the DAO treasury.
contract DriverStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct DriverStake {
        uint256 amount;
        uint64 activatedAt;
        uint64 cooldownEnd;
    }

    IERC20 public immutable rideToken;
    IRideUsdOracle public oracle;
    address public treasury;
    /// @notice Minimum driver collateral expressed in USD with 18-decimal precision.
    ///         Default matches the SOW value of $100. (100e18 = $100.00)
    uint256 public minimumStakeUsdE18;
    uint64 public unstakeCooldown;

    mapping(address driver => DriverStake stakeInfo) public driverStakes;
    mapping(address account => bool allowed) public isSlasher;

    event Staked(address indexed driver, uint256 amount, uint256 totalStaked);
    event UnstakeRequested(address indexed driver, uint64 cooldownEnd);
    event Unstaked(address indexed driver, uint256 amount);
    event DriverSlashed(address indexed driver, address indexed slasher, uint256 amount, string reason);
    event MinimumStakeUsdUpdated(uint256 minimumStakeUsdE18);
    event UnstakeCooldownUpdated(uint64 unstakeCooldown);
    event TreasuryUpdated(address indexed treasury);
    event OracleUpdated(address indexed oracle);
    event SlasherUpdated(address indexed account, bool allowed);

    error ZeroAddress();
    error ZeroAmount();
    error NotActiveDriver();
    error CooldownNotStarted();
    error CooldownNotFinished(uint64 cooldownEnd);
    error SlashExceedsStake();
    error NotAuthorizedSlasher();

    constructor(
        IERC20 rideToken_,
        IRideUsdOracle oracle_,
        address treasury_,
        uint256 minimumStakeUsdE18_,
        uint64 unstakeCooldown_
    ) Ownable(msg.sender) {
        if (
            address(rideToken_) == address(0) || address(oracle_) == address(0) || treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }

        rideToken = rideToken_;
        oracle = oracle_;
        treasury = treasury_;
        minimumStakeUsdE18 = minimumStakeUsdE18_;
        unstakeCooldown = unstakeCooldown_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public view helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Returns the RIDE amount currently required to be an active driver.
    ///         Calculated as: minimumStakeUsdE18 / oracle.latestPrice() * 1e18.
    ///         Uses Math.mulDiv to avoid intermediate overflow.
    function requiredRideStakeAmount() public view returns (uint256) {
        uint256 priceE18 = oracle.latestPrice();
        // minimumStakeUsdE18 * 1e18 / priceE18  →  RIDE tokens (18 decimals)
        return Math.mulDiv(minimumStakeUsdE18, 1 ether, priceE18);
    }

    /// @notice Returns true if the driver has enough staked RIDE (at current oracle price)
    ///         and has not initiated an unstake cooldown.
    function isDriverActive(address driver) public view returns (bool) {
        DriverStake memory info = driverStakes[driver];
        return info.activatedAt != 0
            && info.cooldownEnd == 0
            && info.amount >= requiredRideStakeAmount();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Staking operations
    // ─────────────────────────────────────────────────────────────────────────

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }

        DriverStake storage info = driverStakes[msg.sender];
        rideToken.safeTransferFrom(msg.sender, address(this), amount);

        info.amount += amount;
        info.cooldownEnd = 0;

        if (info.activatedAt == 0 && info.amount >= requiredRideStakeAmount()) {
            info.activatedAt = uint64(block.timestamp);
        }

        emit Staked(msg.sender, amount, info.amount);
    }

    function requestUnstake() external {
        if (!isDriverActive(msg.sender)) {
            revert NotActiveDriver();
        }

        uint64 cooldownEnd = uint64(block.timestamp) + unstakeCooldown;
        driverStakes[msg.sender].cooldownEnd = cooldownEnd;

        emit UnstakeRequested(msg.sender, cooldownEnd);
    }

    function completeUnstake() external nonReentrant {
        DriverStake storage info = driverStakes[msg.sender];

        if (info.cooldownEnd == 0) {
            revert CooldownNotStarted();
        }
        if (block.timestamp < info.cooldownEnd) {
            revert CooldownNotFinished(info.cooldownEnd);
        }

        uint256 amount = info.amount;
        delete driverStakes[msg.sender];

        rideToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function slash(address driver, uint256 amount, string calldata reason) external nonReentrant {
        if (msg.sender != owner() && !isSlasher[msg.sender]) {
            revert NotAuthorizedSlasher();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }

        DriverStake storage info = driverStakes[driver];
        if (amount > info.amount) {
            revert SlashExceedsStake();
        }

        info.amount -= amount;
        if (info.amount < requiredRideStakeAmount()) {
            info.activatedAt = 0;
            info.cooldownEnd = 0;
        }

        rideToken.safeTransfer(treasury, amount);
        emit DriverSlashed(driver, msg.sender, amount, reason);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin setters
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Update the USD minimum stake requirement (1e18 precision).
    function setMinimumStakeUsd(uint256 minimumStakeUsdE18_) external onlyOwner {
        minimumStakeUsdE18 = minimumStakeUsdE18_;
        emit MinimumStakeUsdUpdated(minimumStakeUsdE18_);
    }

    function setUnstakeCooldown(uint64 unstakeCooldown_) external onlyOwner {
        unstakeCooldown = unstakeCooldown_;
        emit UnstakeCooldownUpdated(unstakeCooldown_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) {
            revert ZeroAddress();
        }
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setOracle(IRideUsdOracle oracle_) external onlyOwner {
        if (address(oracle_) == address(0)) {
            revert ZeroAddress();
        }
        oracle = oracle_;
        emit OracleUpdated(address(oracle_));
    }

    function setSlasher(address account, bool allowed) external onlyOwner {
        isSlasher[account] = allowed;
        emit SlasherUpdated(account, allowed);
    }
}

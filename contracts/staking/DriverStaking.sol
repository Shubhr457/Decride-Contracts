// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Driver collateral staking for Decride.
/// @notice Drivers become active by staking the required RIDE collateral.
contract DriverStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct DriverStake {
        uint256 amount;
        uint64 activatedAt;
        uint64 cooldownEnd;
    }

    IERC20 public immutable rideToken;
    address public treasury;
    uint256 public minimumStake;
    uint64 public unstakeCooldown;

    mapping(address driver => DriverStake stakeInfo) public driverStakes;
    mapping(address account => bool allowed) public isSlasher;

    event Staked(address indexed driver, uint256 amount, uint256 totalStaked);
    event UnstakeRequested(address indexed driver, uint64 cooldownEnd);
    event Unstaked(address indexed driver, uint256 amount);
    event DriverSlashed(address indexed driver, address indexed slasher, uint256 amount, string reason);
    event MinimumStakeUpdated(uint256 minimumStake);
    event UnstakeCooldownUpdated(uint64 unstakeCooldown);
    event TreasuryUpdated(address indexed treasury);
    event SlasherUpdated(address indexed account, bool allowed);

    error ZeroAddress();
    error ZeroAmount();
    error NotActiveDriver();
    error CooldownNotStarted();
    error CooldownNotFinished(uint64 cooldownEnd);
    error SlashExceedsStake();
    error NotAuthorizedSlasher();

    constructor(IERC20 rideToken_, address treasury_, uint256 minimumStake_, uint64 unstakeCooldown_)
        Ownable(msg.sender)
    {
        if (address(rideToken_) == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }

        rideToken = rideToken_;
        treasury = treasury_;
        minimumStake = minimumStake_;
        unstakeCooldown = unstakeCooldown_;
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }

        DriverStake storage info = driverStakes[msg.sender];
        rideToken.safeTransferFrom(msg.sender, address(this), amount);

        info.amount += amount;
        info.cooldownEnd = 0;

        if (info.amount >= minimumStake && info.activatedAt == 0) {
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
        if (info.amount < minimumStake) {
            info.activatedAt = 0;
            info.cooldownEnd = 0;
        }

        rideToken.safeTransfer(treasury, amount);
        emit DriverSlashed(driver, msg.sender, amount, reason);
    }

    function isDriverActive(address driver) public view returns (bool) {
        DriverStake memory info = driverStakes[driver];
        return info.amount >= minimumStake && info.activatedAt != 0 && info.cooldownEnd == 0;
    }

    function setMinimumStake(uint256 minimumStake_) external onlyOwner {
        minimumStake = minimumStake_;
        emit MinimumStakeUpdated(minimumStake_);
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

    function setSlasher(address account, bool allowed) external onlyOwner {
        isSlasher[account] = allowed;
        emit SlasherUpdated(account, allowed);
    }
}

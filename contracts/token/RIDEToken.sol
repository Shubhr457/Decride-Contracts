// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title RIDE utility and governance token for Decride.
/// @notice Includes launch anti-whale transfer controls and ERC20Votes support.
contract RIDEToken is ERC20, ERC20Permit, ERC20Votes, Ownable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;
    uint16 public constant BPS_DENOMINATOR = 10_000;

    uint16 public maxTransferBps;
    bool public transferLimitEnabled = true;

    mapping(address account => bool exempt) public isTransferLimitExempt;

    event TransferLimitUpdated(uint16 maxTransferBps, bool enabled);
    event TransferLimitExemptionUpdated(address indexed account, bool exempt);

    error TransferLimitTooHigh();
    error TransferExceedsLaunchLimit(uint256 amount, uint256 maxAmount);

    constructor(address treasury)
        ERC20("Decride Ride Token", "RIDE")
        ERC20Permit("Decride Ride Token")
        Ownable(treasury)
    {
        // OZ Ownable(treasury) already reverts for address(0); no custom check needed.
        maxTransferBps = 200;
        isTransferLimitExempt[treasury] = true;
        isTransferLimitExempt[address(0)] = true;

        _mint(treasury, MAX_SUPPLY);
    }

    /// @notice Updates the maximum transfer percentage while launch controls are enabled.
    function setTransferLimit(uint16 newMaxTransferBps, bool enabled) external onlyOwner {
        if (newMaxTransferBps > BPS_DENOMINATOR) {
            revert TransferLimitTooHigh();
        }

        maxTransferBps = newMaxTransferBps;
        transferLimitEnabled = enabled;

        emit TransferLimitUpdated(newMaxTransferBps, enabled);
    }

    /// @notice Exempts operational contracts from the launch transfer limit.
    function setTransferLimitExempt(address account, bool exempt) external onlyOwner {
        isTransferLimitExempt[account] = exempt;
        emit TransferLimitExemptionUpdated(account, exempt);
    }

    function maxTransferAmount() public view returns (uint256) {
        return (totalSupply() * maxTransferBps) / BPS_DENOMINATOR;
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        if (
            transferLimitEnabled && from != address(0) && to != address(0)
                && !isTransferLimitExempt[from] && !isTransferLimitExempt[to]
        ) {
            uint256 limit = maxTransferAmount();
            if (value > limit) {
                revert TransferExceedsLaunchLimit(value, limit);
            }
        }

        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}

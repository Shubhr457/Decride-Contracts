// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DecrideVestingWallet} from "./DecrideVestingWallet.sol";

/// @title Factory for creating Decride vesting wallets.
/// @notice The DAO or token team calls createVesting() for each allocation bucket
///         (team, investors, ecosystem, advisors, etc.). Each wallet is an independent
///         DecrideVestingWallet with a linear release schedule.
/// @notice After wallet creation the caller must transfer RIDE tokens directly to each
///         wallet address — the factory itself never holds tokens.
contract VestingWalletFactory is Ownable {
    address[] public wallets;

    event VestingCreated(
        uint256 indexed index,
        address indexed wallet,
        address indexed beneficiary,
        uint64 start,
        uint64 duration,
        string label
    );

    error ZeroAddress();
    error ZeroDuration();

    constructor(address owner_) Ownable(owner_) {
        // OZ Ownable(owner_) already reverts for address(0); no custom check needed.
    }

    /// @notice Deploy a new DecrideVestingWallet.
    /// @param beneficiary   Address that will receive vested tokens.
    /// @param start         Unix timestamp (seconds) at which vesting starts.
    /// @param duration      Total vesting duration in seconds.
    /// @param label         Human-readable tag (e.g. "Team", "Investor Series A").
    /// @return wallet       Address of the newly deployed wallet.
    function createVesting(
        address beneficiary,
        uint64 start,
        uint64 duration,
        string calldata label
    ) external onlyOwner returns (address wallet) {
        if (beneficiary == address(0)) {
            revert ZeroAddress();
        }
        if (duration == 0) {
            revert ZeroDuration();
        }

        DecrideVestingWallet newWallet = new DecrideVestingWallet(beneficiary, start, duration, label);
        wallet = address(newWallet);
        wallets.push(wallet);

        emit VestingCreated(wallets.length - 1, wallet, beneficiary, start, duration, label);
    }

    /// @notice Total number of vesting wallets created by this factory.
    function walletCount() external view returns (uint256) {
        return wallets.length;
    }
}

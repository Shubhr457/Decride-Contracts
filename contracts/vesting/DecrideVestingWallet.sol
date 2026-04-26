// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";

/// @title Decride vesting wallet.
/// @notice Thin wrapper around OpenZeppelin VestingWallet that adds project-specific
///         metadata (label) for off-chain indexing and traceability.
/// @dev Tokens vest linearly from `start` to `start + duration`. Cliff behaviour can
///      be achieved by setting `start` to the cliff timestamp.
contract DecrideVestingWallet is VestingWallet {
    string public label;

    event LabelSet(string label);

    constructor(
        address beneficiary,
        uint64 startTimestamp,
        uint64 durationSeconds,
        string memory label_
    ) VestingWallet(beneficiary, startTimestamp, durationSeconds) {
        label = label_;
        emit LabelSet(label_);
    }
}

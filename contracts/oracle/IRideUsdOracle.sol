// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Oracle interface for the USD price of one RIDE token.
/// @notice Returns the price of 1 RIDE expressed in USD with 18-decimal precision (e18).
///         Example: if 1 RIDE = $0.10, latestPrice() returns 0.1e18 (100000000000000000).
///         Production deployments should implement this interface against a Chainlink
///         aggregator or equivalent decentralized feed.
interface IRideUsdOracle {
    /// @notice Returns the USD price of 1 RIDE token, scaled to 1e18.
    /// @dev Must always return a strictly positive value; callers rely on this invariant.
    function latestPrice() external view returns (uint256 priceE18);
}

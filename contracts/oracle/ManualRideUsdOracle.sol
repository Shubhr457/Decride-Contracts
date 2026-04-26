// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRideUsdOracle} from "./IRideUsdOracle.sol";

/// @title Owner-governed RIDE/USD price feed.
/// @notice Provides a manually maintained price of 1 RIDE in USD (1e18 precision).
///         Intended for development and staging. Replace with a Chainlink feed for mainnet.
contract ManualRideUsdOracle is IRideUsdOracle, Ownable {
    /// @notice Minimum allowed price: $0.000001 (prevents division-by-zero in consumers).
    uint256 public constant MIN_PRICE_E18 = 1e12;

    uint256 private _priceE18;

    event PriceUpdated(uint256 indexed oldPrice, uint256 indexed newPrice);

    error PriceTooLow(uint256 price, uint256 minimum);
    error ZeroAddress();

    constructor(address owner_, uint256 initialPriceE18) Ownable(owner_) {
        // OZ Ownable(owner_) already reverts for address(0); no custom check needed.
        _validateAndSet(initialPriceE18);
    }

    /// @notice Returns the latest manually set USD price of 1 RIDE (1e18 precision).
    function latestPrice() external view override returns (uint256) {
        return _priceE18;
    }

    /// @notice Owner updates the price. Must be >= MIN_PRICE_E18.
    function setPrice(uint256 newPriceE18) external onlyOwner {
        uint256 old = _priceE18;
        _validateAndSet(newPriceE18);
        emit PriceUpdated(old, newPriceE18);
    }

    function _validateAndSet(uint256 priceE18) internal {
        if (priceE18 < MIN_PRICE_E18) {
            revert PriceTooLow(priceE18, MIN_PRICE_E18);
        }
        _priceE18 = priceE18;
    }
}

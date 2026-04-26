// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDriverStaking {
    function isDriverActive(address driver) external view returns (bool);

    function requiredRideStakeAmount() external view returns (uint256);

    function minimumStakeUsdE18() external view returns (uint256);
}

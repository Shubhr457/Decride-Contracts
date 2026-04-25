// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDriverStaking {
    function isDriverActive(address driver) external view returns (bool);
}

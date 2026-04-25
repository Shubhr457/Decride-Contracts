// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRideEscrow {
    function rides(uint256 rideId)
        external
        view
        returns (
            address rider,
            address driver,
            address paymentToken,
            uint256 fareAmount,
            uint64 requestedAt,
            uint64 matchedAt,
            bytes32 metadataHash,
            uint8 status,
            bool riderConfirmed,
            bool driverConfirmed
        );

    function resolveDispute(uint256 rideId, uint256 driverAmount, uint256 riderAmount) external;
}

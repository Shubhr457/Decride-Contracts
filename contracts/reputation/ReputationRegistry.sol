// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRideEscrow} from "../interfaces/IRideEscrow.sol";

/// @title Reputation registry for Decride riders and drivers.
/// @notice Ratings are accepted only from verified participants of completed rides.
contract ReputationRegistry is Ownable {
    enum ProfileKind {
        Rider,
        Driver
    }

    struct Reputation {
        uint64 ratingCount;
        uint64 totalScore;
        uint256 averageScoreE18;
    }

    uint8 public constant MIN_SCORE = 1;
    uint8 public constant MAX_SCORE = 5;
    uint8 public constant ESCROW_STATUS_COMPLETED = 4;

    IRideEscrow public rideEscrow;
    uint256 public minimumDriverAverageE18;

    mapping(address account => Reputation reputation) public riderReputation;
    mapping(address account => Reputation reputation) public driverReputation;
    mapping(uint256 rideId => mapping(address rater => bool submitted)) public hasSubmittedRating;

    event RatingSubmitted(
        uint256 indexed rideId,
        address indexed rater,
        address indexed subject,
        ProfileKind subjectKind,
        uint8 score
    );
    event RideEscrowUpdated(address indexed rideEscrow);
    event MinimumDriverAverageUpdated(uint256 minimumDriverAverageE18);

    error ZeroAddress();
    error RideNotCompleted();
    error NotRideParticipant();
    error RatingAlreadySubmitted();
    error InvalidScore();

    constructor(IRideEscrow rideEscrow_, uint256 minimumDriverAverageE18_) Ownable(msg.sender) {
        if (address(rideEscrow_) == address(0)) {
            revert ZeroAddress();
        }

        rideEscrow = rideEscrow_;
        minimumDriverAverageE18 = minimumDriverAverageE18_;
    }

    function submitRating(uint256 rideId, uint8 score) external {
        if (score < MIN_SCORE || score > MAX_SCORE) {
            revert InvalidScore();
        }
        if (hasSubmittedRating[rideId][msg.sender]) {
            revert RatingAlreadySubmitted();
        }

        (address rider, address driver,,,,,, uint8 status,,) = rideEscrow.rides(rideId);
        if (status != ESCROW_STATUS_COMPLETED) {
            revert RideNotCompleted();
        }

        address subject;
        ProfileKind subjectKind;
        Reputation storage reputation;

        if (msg.sender == rider) {
            subject = driver;
            subjectKind = ProfileKind.Driver;
            reputation = driverReputation[driver];
        } else if (msg.sender == driver) {
            subject = rider;
            subjectKind = ProfileKind.Rider;
            reputation = riderReputation[rider];
        } else {
            revert NotRideParticipant();
        }

        hasSubmittedRating[rideId][msg.sender] = true;
        _applyRating(reputation, score);

        emit RatingSubmitted(rideId, msg.sender, subject, subjectKind, score);
    }

    function isDriverAboveThreshold(address driver) external view returns (bool) {
        Reputation memory reputation = driverReputation[driver];
        if (reputation.ratingCount == 0) {
            return true;
        }

        return reputation.averageScoreE18 >= minimumDriverAverageE18;
    }

    function setRideEscrow(IRideEscrow rideEscrow_) external onlyOwner {
        if (address(rideEscrow_) == address(0)) {
            revert ZeroAddress();
        }

        rideEscrow = rideEscrow_;
        emit RideEscrowUpdated(address(rideEscrow_));
    }

    function setMinimumDriverAverage(uint256 minimumDriverAverageE18_) external onlyOwner {
        minimumDriverAverageE18 = minimumDriverAverageE18_;
        emit MinimumDriverAverageUpdated(minimumDriverAverageE18_);
    }

    function _applyRating(Reputation storage reputation, uint8 score) internal {
        reputation.ratingCount += 1;
        reputation.totalScore += score;
        reputation.averageScoreE18 = (uint256(reputation.totalScore) * 1 ether) / reputation.ratingCount;
    }
}

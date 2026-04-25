// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDriverStaking} from "../interfaces/IDriverStaking.sol";

/// @title Ride escrow and lifecycle state machine for Decride.
/// @notice Keeps payment-critical ride state on-chain while route and evidence data remain off-chain.
contract RideEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum RideStatus {
        None,
        Requested,
        Matched,
        Active,
        Completed,
        Disputed,
        Refunded,
        Cancelled
    }

    struct Ride {
        address rider;
        address driver;
        IERC20 paymentToken;
        uint256 fareAmount;
        uint64 requestedAt;
        uint64 matchedAt;
        bytes32 metadataHash;
        RideStatus status;
        bool riderConfirmed;
        bool driverConfirmed;
    }

    uint16 public constant BPS_DENOMINATOR = 10_000;

    IDriverStaking public driverStaking;
    address public treasury;
    address public matcher;
    address public disputeResolver;
    uint16 public platformFeeBps;
    uint64 public requestTimeout;
    uint256 public nextRideId = 1;

    mapping(uint256 rideId => Ride ride) public rides;

    event RideRequested(
        uint256 indexed rideId,
        address indexed rider,
        address indexed paymentToken,
        uint256 fareAmount,
        bytes32 metadataHash
    );
    event RideMatched(uint256 indexed rideId, address indexed driver);
    event RideStarted(uint256 indexed rideId);
    event RideCompletionConfirmed(uint256 indexed rideId, address indexed participant);
    event RideSettled(uint256 indexed rideId, uint256 driverPayout, uint256 platformFee);
    event RideDisputed(uint256 indexed rideId, address indexed openedBy, bytes32 evidenceHash);
    event RideRefunded(uint256 indexed rideId, uint256 amount);
    event RideCancelled(uint256 indexed rideId);
    event RideDisputeResolved(uint256 indexed rideId, uint256 driverAmount, uint256 riderAmount);
    event MatcherUpdated(address indexed matcher);
    event DisputeResolverUpdated(address indexed disputeResolver);
    event TreasuryUpdated(address indexed treasury);
    event PlatformFeeUpdated(uint16 platformFeeBps);
    event RequestTimeoutUpdated(uint64 requestTimeout);

    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh();
    error RideNotFound();
    error InvalidRideStatus(RideStatus current);
    error NotMatcher();
    error NotRideParticipant();
    error DriverNotActive();
    error RequestStillActive(uint64 refundableAt);
    error InvalidDisputeSplit();

    constructor(
        IDriverStaking driverStaking_,
        address treasury_,
        address matcher_,
        address disputeResolver_,
        uint16 platformFeeBps_,
        uint64 requestTimeout_
    ) Ownable(msg.sender) {
        if (
            address(driverStaking_) == address(0) || treasury_ == address(0) || matcher_ == address(0)
                || disputeResolver_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (platformFeeBps_ > BPS_DENOMINATOR) {
            revert FeeTooHigh();
        }

        driverStaking = driverStaking_;
        treasury = treasury_;
        matcher = matcher_;
        disputeResolver = disputeResolver_;
        platformFeeBps = platformFeeBps_;
        requestTimeout = requestTimeout_;
    }

    function requestRide(IERC20 paymentToken, uint256 fareAmount, bytes32 metadataHash)
        external
        nonReentrant
        returns (uint256 rideId)
    {
        if (address(paymentToken) == address(0)) {
            revert ZeroAddress();
        }
        if (fareAmount == 0) {
            revert ZeroAmount();
        }

        rideId = nextRideId++;
        rides[rideId] = Ride({
            rider: msg.sender,
            driver: address(0),
            paymentToken: paymentToken,
            fareAmount: fareAmount,
            requestedAt: uint64(block.timestamp),
            matchedAt: 0,
            metadataHash: metadataHash,
            status: RideStatus.Requested,
            riderConfirmed: false,
            driverConfirmed: false
        });

        paymentToken.safeTransferFrom(msg.sender, address(this), fareAmount);
        emit RideRequested(rideId, msg.sender, address(paymentToken), fareAmount, metadataHash);
    }

    function matchRide(uint256 rideId, address driver) external {
        if (msg.sender != matcher) {
            revert NotMatcher();
        }
        if (!driverStaking.isDriverActive(driver)) {
            revert DriverNotActive();
        }

        Ride storage ride = _ride(rideId);
        _requireStatus(ride, RideStatus.Requested);

        ride.driver = driver;
        ride.matchedAt = uint64(block.timestamp);
        ride.status = RideStatus.Matched;

        emit RideMatched(rideId, driver);
    }

    function startRide(uint256 rideId) external {
        Ride storage ride = _ride(rideId);
        _requireStatus(ride, RideStatus.Matched);
        _requireParticipant(ride);

        ride.status = RideStatus.Active;
        emit RideStarted(rideId);
    }

    function confirmCompletion(uint256 rideId) external nonReentrant {
        Ride storage ride = _ride(rideId);
        _requireStatus(ride, RideStatus.Active);
        _requireParticipant(ride);

        if (msg.sender == ride.rider) {
            ride.riderConfirmed = true;
        } else {
            ride.driverConfirmed = true;
        }

        emit RideCompletionConfirmed(rideId, msg.sender);

        if (ride.riderConfirmed && ride.driverConfirmed) {
            _settleRide(rideId, ride, ride.fareAmount, 0);
        }
    }

    function disputeRide(uint256 rideId, bytes32 evidenceHash) external {
        Ride storage ride = _ride(rideId);
        if (ride.status != RideStatus.Matched && ride.status != RideStatus.Active) {
            revert InvalidRideStatus(ride.status);
        }
        _requireParticipant(ride);

        ride.status = RideStatus.Disputed;
        emit RideDisputed(rideId, msg.sender, evidenceHash);
    }

    function resolveDispute(uint256 rideId, uint256 driverAmount, uint256 riderAmount) external nonReentrant {
        if (msg.sender != disputeResolver) {
            revert NotMatcher();
        }

        Ride storage ride = _ride(rideId);
        _requireStatus(ride, RideStatus.Disputed);
        if (driverAmount + riderAmount != ride.fareAmount) {
            revert InvalidDisputeSplit();
        }

        emit RideDisputeResolved(rideId, driverAmount, riderAmount);
        _settleRide(rideId, ride, driverAmount, riderAmount);
    }

    function refundExpiredRequest(uint256 rideId) external nonReentrant {
        Ride storage ride = _ride(rideId);
        _requireStatus(ride, RideStatus.Requested);

        uint64 refundableAt = ride.requestedAt + requestTimeout;
        if (block.timestamp < refundableAt) {
            revert RequestStillActive(refundableAt);
        }

        ride.status = RideStatus.Refunded;
        ride.paymentToken.safeTransfer(ride.rider, ride.fareAmount);

        emit RideRefunded(rideId, ride.fareAmount);
    }

    function cancelRequest(uint256 rideId) external nonReentrant {
        Ride storage ride = _ride(rideId);
        _requireStatus(ride, RideStatus.Requested);
        if (msg.sender != ride.rider) {
            revert NotRideParticipant();
        }

        ride.status = RideStatus.Cancelled;
        ride.paymentToken.safeTransfer(ride.rider, ride.fareAmount);

        emit RideCancelled(rideId);
    }

    function setMatcher(address matcher_) external onlyOwner {
        if (matcher_ == address(0)) {
            revert ZeroAddress();
        }

        matcher = matcher_;
        emit MatcherUpdated(matcher_);
    }

    function setDisputeResolver(address disputeResolver_) external onlyOwner {
        if (disputeResolver_ == address(0)) {
            revert ZeroAddress();
        }

        disputeResolver = disputeResolver_;
        emit DisputeResolverUpdated(disputeResolver_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) {
            revert ZeroAddress();
        }

        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setPlatformFee(uint16 platformFeeBps_) external onlyOwner {
        if (platformFeeBps_ > BPS_DENOMINATOR) {
            revert FeeTooHigh();
        }

        platformFeeBps = platformFeeBps_;
        emit PlatformFeeUpdated(platformFeeBps_);
    }

    function setRequestTimeout(uint64 requestTimeout_) external onlyOwner {
        requestTimeout = requestTimeout_;
        emit RequestTimeoutUpdated(requestTimeout_);
    }

    function _settleRide(uint256 rideId, Ride storage ride, uint256 driverAmount, uint256 riderAmount) internal {
        ride.status = RideStatus.Completed;

        uint256 platformFee = (driverAmount * platformFeeBps) / BPS_DENOMINATOR;
        uint256 driverPayout = driverAmount - platformFee;

        if (driverPayout != 0) {
            ride.paymentToken.safeTransfer(ride.driver, driverPayout);
        }
        if (platformFee != 0) {
            ride.paymentToken.safeTransfer(treasury, platformFee);
        }
        if (riderAmount != 0) {
            ride.paymentToken.safeTransfer(ride.rider, riderAmount);
        }

        emit RideSettled(rideId, driverPayout, platformFee);
    }

    function _ride(uint256 rideId) internal view returns (Ride storage ride) {
        ride = rides[rideId];
        if (ride.rider == address(0)) {
            revert RideNotFound();
        }
    }

    function _requireStatus(Ride storage ride, RideStatus expected) internal view {
        if (ride.status != expected) {
            revert InvalidRideStatus(ride.status);
        }
    }

    function _requireParticipant(Ride storage ride) internal view {
        if (msg.sender != ride.rider && msg.sender != ride.driver) {
            revert NotRideParticipant();
        }
    }
}

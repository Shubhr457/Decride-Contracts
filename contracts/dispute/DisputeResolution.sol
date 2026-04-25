// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRideEscrow} from "../interfaces/IRideEscrow.sol";

/// @title Jury-based dispute resolution for Decride rides.
/// @notice Arbitrators stake RIDE, vote on disputed ride outcomes, and can be slashed by governance.
contract DisputeResolution is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum VoteChoice {
        None,
        Driver,
        Rider,
        Split
    }

    struct CaseData {
        uint256 rideId;
        uint64 openedAt;
        bool executed;
        uint16 driverVotes;
        uint16 riderVotes;
        uint16 splitVotes;
        address[] jury;
    }

    uint8 public constant ESCROW_STATUS_DISPUTED = 5;

    IERC20 public immutable rideToken;
    IRideEscrow public rideEscrow;
    address public treasury;
    uint256 public minimumArbitratorStake;
    uint64 public votingPeriod;
    uint256 public nextCaseId = 1;

    mapping(address arbitrator => uint256 amount) public arbitratorStake;
    mapping(uint256 caseId => CaseData data) private cases;
    mapping(uint256 caseId => mapping(address arbitrator => bool selected)) public isJuror;
    mapping(uint256 caseId => mapping(address arbitrator => VoteChoice choice)) public votes;

    event ArbitratorStaked(address indexed arbitrator, uint256 amount, uint256 totalStaked);
    event ArbitratorUnstaked(address indexed arbitrator, uint256 amount);
    event ArbitratorSlashed(address indexed arbitrator, uint256 amount, string reason);
    event CaseOpened(uint256 indexed caseId, uint256 indexed rideId, address[] jury);
    event VoteSubmitted(uint256 indexed caseId, address indexed arbitrator, VoteChoice choice);
    event CaseExecuted(uint256 indexed caseId, VoteChoice winningChoice, uint256 driverAmount, uint256 riderAmount);
    event RideEscrowUpdated(address indexed rideEscrow);
    event TreasuryUpdated(address indexed treasury);
    event MinimumArbitratorStakeUpdated(uint256 minimumArbitratorStake);
    event VotingPeriodUpdated(uint64 votingPeriod);

    error ZeroAddress();
    error ZeroAmount();
    error NotDisputedRide();
    error EmptyJury();
    error ArbitratorNotQualified(address arbitrator);
    error CaseNotFound();
    error CaseAlreadyExecuted();
    error NotSelectedJuror();
    error VoteAlreadySubmitted();
    error InvalidVoteChoice();
    error VotingStillOpen(uint64 closesAt);
    error VotingClosed(uint64 closesAt);
    error NoVotesSubmitted();
    error SlashExceedsStake();

    constructor(
        IERC20 rideToken_,
        IRideEscrow rideEscrow_,
        address treasury_,
        uint256 minimumArbitratorStake_,
        uint64 votingPeriod_
    ) Ownable(msg.sender) {
        if (address(rideToken_) == address(0) || address(rideEscrow_) == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }

        rideToken = rideToken_;
        rideEscrow = rideEscrow_;
        treasury = treasury_;
        minimumArbitratorStake = minimumArbitratorStake_;
        votingPeriod = votingPeriod_;
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }

        arbitratorStake[msg.sender] += amount;
        rideToken.safeTransferFrom(msg.sender, address(this), amount);

        emit ArbitratorStaked(msg.sender, amount, arbitratorStake[msg.sender]);
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (amount > arbitratorStake[msg.sender]) {
            revert SlashExceedsStake();
        }

        arbitratorStake[msg.sender] -= amount;
        rideToken.safeTransfer(msg.sender, amount);

        emit ArbitratorUnstaked(msg.sender, amount);
    }

    function openCase(uint256 rideId, address[] calldata jury) external onlyOwner returns (uint256 caseId) {
        if (jury.length == 0) {
            revert EmptyJury();
        }

        (,,, uint256 fareAmount,,,, uint8 status,,) = rideEscrow.rides(rideId);
        if (status != ESCROW_STATUS_DISPUTED || fareAmount == 0) {
            revert NotDisputedRide();
        }

        caseId = nextCaseId++;
        CaseData storage caseData = cases[caseId];
        caseData.rideId = rideId;
        caseData.openedAt = uint64(block.timestamp);

        for (uint256 i = 0; i < jury.length; i++) {
            address arbitrator = jury[i];
            if (arbitrator == address(0)) {
                revert ZeroAddress();
            }
            if (arbitratorStake[arbitrator] < minimumArbitratorStake) {
                revert ArbitratorNotQualified(arbitrator);
            }

            isJuror[caseId][arbitrator] = true;
            caseData.jury.push(arbitrator);
        }

        emit CaseOpened(caseId, rideId, jury);
    }

    function vote(uint256 caseId, VoteChoice choice) external {
        CaseData storage caseData = _case(caseId);
        if (caseData.executed) {
            revert CaseAlreadyExecuted();
        }
        if (block.timestamp >= caseData.openedAt + votingPeriod) {
            revert VotingClosed(caseData.openedAt + votingPeriod);
        }
        if (!isJuror[caseId][msg.sender]) {
            revert NotSelectedJuror();
        }
        if (votes[caseId][msg.sender] != VoteChoice.None) {
            revert VoteAlreadySubmitted();
        }
        if (choice == VoteChoice.None) {
            revert InvalidVoteChoice();
        }

        votes[caseId][msg.sender] = choice;
        if (choice == VoteChoice.Driver) {
            caseData.driverVotes += 1;
        } else if (choice == VoteChoice.Rider) {
            caseData.riderVotes += 1;
        } else {
            caseData.splitVotes += 1;
        }

        emit VoteSubmitted(caseId, msg.sender, choice);
    }

    function executeCase(uint256 caseId) external nonReentrant {
        CaseData storage caseData = _case(caseId);
        if (caseData.executed) {
            revert CaseAlreadyExecuted();
        }

        uint64 closesAt = caseData.openedAt + votingPeriod;
        if (block.timestamp < closesAt) {
            revert VotingStillOpen(closesAt);
        }

        uint256 totalVotes = uint256(caseData.driverVotes) + caseData.riderVotes + caseData.splitVotes;
        if (totalVotes == 0) {
            revert NoVotesSubmitted();
        }

        (,,, uint256 fareAmount,,,,,,) = rideEscrow.rides(caseData.rideId);
        (VoteChoice winner, uint256 driverAmount, uint256 riderAmount) = _outcome(caseData, fareAmount);

        caseData.executed = true;
        rideEscrow.resolveDispute(caseData.rideId, driverAmount, riderAmount);

        emit CaseExecuted(caseId, winner, driverAmount, riderAmount);
    }

    function slashArbitrator(address arbitrator, uint256 amount, string calldata reason) external onlyOwner nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (amount > arbitratorStake[arbitrator]) {
            revert SlashExceedsStake();
        }

        arbitratorStake[arbitrator] -= amount;
        rideToken.safeTransfer(treasury, amount);

        emit ArbitratorSlashed(arbitrator, amount, reason);
    }

    function getCase(uint256 caseId) external view returns (CaseData memory) {
        return _case(caseId);
    }

    function setRideEscrow(IRideEscrow rideEscrow_) external onlyOwner {
        if (address(rideEscrow_) == address(0)) {
            revert ZeroAddress();
        }

        rideEscrow = rideEscrow_;
        emit RideEscrowUpdated(address(rideEscrow_));
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) {
            revert ZeroAddress();
        }

        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setMinimumArbitratorStake(uint256 minimumArbitratorStake_) external onlyOwner {
        minimumArbitratorStake = minimumArbitratorStake_;
        emit MinimumArbitratorStakeUpdated(minimumArbitratorStake_);
    }

    function setVotingPeriod(uint64 votingPeriod_) external onlyOwner {
        votingPeriod = votingPeriod_;
        emit VotingPeriodUpdated(votingPeriod_);
    }

    function _outcome(CaseData storage caseData, uint256 fareAmount)
        internal
        view
        returns (VoteChoice winner, uint256 driverAmount, uint256 riderAmount)
    {
        if (caseData.driverVotes >= caseData.riderVotes && caseData.driverVotes >= caseData.splitVotes) {
            return (VoteChoice.Driver, fareAmount, 0);
        }
        if (caseData.riderVotes >= caseData.driverVotes && caseData.riderVotes >= caseData.splitVotes) {
            return (VoteChoice.Rider, 0, fareAmount);
        }

        uint256 splitDriverAmount = fareAmount / 2;
        return (VoteChoice.Split, splitDriverAmount, fareAmount - splitDriverAmount);
    }

    function _case(uint256 caseId) internal view returns (CaseData storage caseData) {
        caseData = cases[caseId];
        if (caseData.rideId == 0) {
            revert CaseNotFound();
        }
    }
}

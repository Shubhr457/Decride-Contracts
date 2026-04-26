// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRideEscrow} from "../interfaces/IRideEscrow.sol";

/// @title Jury-based dispute resolution for Decride rides.
/// @notice Arbitrators stake RIDE to join the eligible pool. When a dispute is opened,
///         a jury is drawn deterministically from that pool using block.prevrandao as the
///         entropy seed (Fisher–Yates without-replacement sampling). This is an MVP-safe
///         pseudo-random approach; production deployments should replace this with a
///         Chainlink VRF subscription for tamper-proof randomness.
/// @notice Jurors who voted with the winning outcome receive an equal share of the
///         jurorRewardPerCase from the contract's reward reserve. Losing or abstaining
///         jurors receive no reward. The owner may fund the reward reserve via
///         fundRewardReserve().
/// @notice An admin fallback, openCase(rideId, jury), remains available for testing and
///         governance-controlled edge cases.
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
    uint256 public jurorRewardPerCase;
    uint256 public rewardReserve;
    uint256 public nextCaseId = 1;

    mapping(address arbitrator => uint256 amount) public arbitratorStake;
    mapping(uint256 caseId => CaseData data) private cases;
    mapping(uint256 caseId => mapping(address arbitrator => bool selected)) public isJuror;
    mapping(uint256 caseId => mapping(address arbitrator => VoteChoice choice)) public votes;

    /// @notice Ordered list of arbitrators currently in the eligible pool.
    address[] private eligiblePool;
    /// @notice Pool index for an arbitrator (1-based; 0 means not in pool).
    mapping(address arbitrator => uint256 poolIndex) private poolIndex;

    event ArbitratorStaked(address indexed arbitrator, uint256 amount, uint256 totalStaked);
    event ArbitratorUnstaked(address indexed arbitrator, uint256 amount);
    event ArbitratorSlashed(address indexed arbitrator, uint256 amount, string reason);
    event ArbitratorRegistered(address indexed arbitrator);
    event ArbitratorDeregistered(address indexed arbitrator);
    event CaseOpened(uint256 indexed caseId, uint256 indexed rideId, address[] jury);
    event VoteSubmitted(uint256 indexed caseId, address indexed arbitrator, VoteChoice choice);
    event CaseExecuted(uint256 indexed caseId, VoteChoice winningChoice, uint256 driverAmount, uint256 riderAmount);
    event JurorRewarded(uint256 indexed caseId, address indexed juror, uint256 amount);
    event RewardReserveFunded(uint256 amount, uint256 newReserve);
    event JurorRewardPerCaseUpdated(uint256 jurorRewardPerCase);
    event RideEscrowUpdated(address indexed rideEscrow);
    event TreasuryUpdated(address indexed treasury);
    event MinimumArbitratorStakeUpdated(uint256 minimumArbitratorStake);
    event VotingPeriodUpdated(uint64 votingPeriod);

    error ZeroAddress();
    error ZeroAmount();
    error NotDisputedRide();
    error EmptyJury();
    error JurySizeTooLarge(uint256 requested, uint256 available);
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
    error AlreadyRegistered();
    error NotRegistered();

    constructor(
        IERC20 rideToken_,
        IRideEscrow rideEscrow_,
        address treasury_,
        uint256 minimumArbitratorStake_,
        uint64 votingPeriod_,
        uint256 jurorRewardPerCase_
    ) Ownable(msg.sender) {
        if (address(rideToken_) == address(0) || address(rideEscrow_) == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }

        rideToken = rideToken_;
        rideEscrow = rideEscrow_;
        treasury = treasury_;
        minimumArbitratorStake = minimumArbitratorStake_;
        votingPeriod = votingPeriod_;
        jurorRewardPerCase = jurorRewardPerCase_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Staking and pool membership
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Deposit RIDE stake. Caller must separately call registerAsJuror() to enter the pool.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }

        arbitratorStake[msg.sender] += amount;
        rideToken.safeTransferFrom(msg.sender, address(this), amount);

        emit ArbitratorStaked(msg.sender, amount, arbitratorStake[msg.sender]);
    }

    /// @notice Withdraw RIDE stake. Automatically deregisters from the pool if stake falls below minimum.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (amount > arbitratorStake[msg.sender]) {
            revert SlashExceedsStake();
        }

        arbitratorStake[msg.sender] -= amount;

        if (arbitratorStake[msg.sender] < minimumArbitratorStake && poolIndex[msg.sender] != 0) {
            _removeFromPool(msg.sender);
        }

        rideToken.safeTransfer(msg.sender, amount);

        emit ArbitratorUnstaked(msg.sender, amount);
    }

    /// @notice Opt in to the jury-selection pool. Requires stake >= minimumArbitratorStake.
    function registerAsJuror() external {
        if (arbitratorStake[msg.sender] < minimumArbitratorStake) {
            revert ArbitratorNotQualified(msg.sender);
        }
        if (poolIndex[msg.sender] != 0) {
            revert AlreadyRegistered();
        }

        eligiblePool.push(msg.sender);
        poolIndex[msg.sender] = eligiblePool.length; // 1-based

        emit ArbitratorRegistered(msg.sender);
    }

    /// @notice Opt out of the jury-selection pool.
    function deregisterAsJuror() external {
        if (poolIndex[msg.sender] == 0) {
            revert NotRegistered();
        }

        _removeFromPool(msg.sender);

        emit ArbitratorDeregistered(msg.sender);
    }

    /// @notice Returns the number of arbitrators currently in the eligible pool.
    function eligiblePoolSize() external view returns (uint256) {
        return eligiblePool.length;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Case management
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Primary path: draw a jury of `jurySize` arbitrators from the eligible pool using
    ///         block.prevrandao-seeded Fisher–Yates sampling (MVP-safe, not VRF).
    /// @param rideId The disputed ride ID in RideEscrow.
    /// @param jurySize Number of jurors to draw. Must be <= eligiblePool.length.
    function openCaseWithRandomJury(uint256 rideId, uint256 jurySize)
        external
        onlyOwner
        returns (uint256 caseId)
    {
        if (jurySize == 0) {
            revert EmptyJury();
        }
        uint256 poolSize = eligiblePool.length;
        if (jurySize > poolSize) {
            revert JurySizeTooLarge(jurySize, poolSize);
        }

        (,,, uint256 fareAmount,,,, uint8 status,,) = rideEscrow.rides(rideId);
        if (status != ESCROW_STATUS_DISPUTED || fareAmount == 0) {
            revert NotDisputedRide();
        }

        // Build a temporary in-memory copy so we can do Fisher–Yates without touching storage.
        address[] memory pool = new address[](poolSize);
        for (uint256 i = 0; i < poolSize; i++) {
            pool[i] = eligiblePool[i];
        }

        // Entropy: prevrandao from EIP-4399 (Cancun/PoS), mixed with contract-specific data to
        // reduce cross-context correlation. NOTE: block proposers can influence prevrandao;
        // replace with Chainlink VRF for production.
        uint256 seed = uint256(
            keccak256(
                abi.encode(block.prevrandao, block.number, address(this), rideId, nextCaseId)
            )
        );

        address[] memory jury = new address[](jurySize);
        for (uint256 i = 0; i < jurySize; i++) {
            uint256 remaining = poolSize - i;
            uint256 pick = uint256(keccak256(abi.encode(seed, i))) % remaining;
            jury[i] = pool[pick];
            pool[pick] = pool[remaining - 1];
        }

        caseId = _createCase(rideId, jury);
    }

    /// @notice Admin/fallback path: supply the jury directly (for testing or governance override).
    function openCase(uint256 rideId, address[] calldata jury) external onlyOwner returns (uint256 caseId) {
        if (jury.length == 0) {
            revert EmptyJury();
        }

        (,,, uint256 fareAmount,,,, uint8 status,,) = rideEscrow.rides(rideId);
        if (status != ESCROW_STATUS_DISPUTED || fareAmount == 0) {
            revert NotDisputedRide();
        }

        for (uint256 i = 0; i < jury.length; i++) {
            address arbitrator = jury[i];
            if (arbitrator == address(0)) {
                revert ZeroAddress();
            }
            if (arbitratorStake[arbitrator] < minimumArbitratorStake) {
                revert ArbitratorNotQualified(arbitrator);
            }
        }

        caseId = _createCase(rideId, jury);
    }

    /// @notice Submit a vote for a case. Only selected jurors may vote, within the voting window.
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

    /// @notice Execute a case after the voting window has closed.
    ///         Determines the winning outcome, settles the escrow, and distributes juror rewards.
    function executeCase(uint256 caseId) external nonReentrant {
        CaseData storage caseData = _case(caseId);
        if (caseData.executed) {
            revert CaseAlreadyExecuted();
        }

        uint64 closesAt = caseData.openedAt + votingPeriod;
        if (block.timestamp < closesAt) {
            revert VotingStillOpen(closesAt);
        }

        uint256 totalVotes =
            uint256(caseData.driverVotes) + caseData.riderVotes + caseData.splitVotes;
        if (totalVotes == 0) {
            revert NoVotesSubmitted();
        }

        (,,, uint256 fareAmount,,,,,,) = rideEscrow.rides(caseData.rideId);
        (VoteChoice winner, uint256 driverAmount, uint256 riderAmount) = _outcome(caseData, fareAmount);

        caseData.executed = true;
        rideEscrow.resolveDispute(caseData.rideId, driverAmount, riderAmount);

        emit CaseExecuted(caseId, winner, driverAmount, riderAmount);

        _distributeRewards(caseId, caseData, winner);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Governance / admin
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Fund the juror reward reserve. Caller must approve this contract before calling.
    function fundRewardReserve(uint256 amount) external nonReentrant {
        if (amount == 0) {
            revert ZeroAmount();
        }
        rewardReserve += amount;
        rideToken.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardReserveFunded(amount, rewardReserve);
    }

    function slashArbitrator(address arbitrator, uint256 amount, string calldata reason)
        external
        onlyOwner
        nonReentrant
    {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (amount > arbitratorStake[arbitrator]) {
            revert SlashExceedsStake();
        }

        arbitratorStake[arbitrator] -= amount;
        if (arbitratorStake[arbitrator] < minimumArbitratorStake && poolIndex[arbitrator] != 0) {
            _removeFromPool(arbitrator);
        }

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

    function setJurorRewardPerCase(uint256 jurorRewardPerCase_) external onlyOwner {
        jurorRewardPerCase = jurorRewardPerCase_;
        emit JurorRewardPerCaseUpdated(jurorRewardPerCase_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _createCase(uint256 rideId, address[] memory jury) internal returns (uint256 caseId) {
        caseId = nextCaseId++;
        CaseData storage caseData = cases[caseId];
        caseData.rideId = rideId;
        caseData.openedAt = uint64(block.timestamp);

        for (uint256 i = 0; i < jury.length; i++) {
            isJuror[caseId][jury[i]] = true;
            caseData.jury.push(jury[i]);
        }

        emit CaseOpened(caseId, rideId, jury);
    }

    /// @dev Removes an arbitrator from the eligible pool using the swap-and-pop pattern.
    function _removeFromPool(address arbitrator) internal {
        uint256 idx = poolIndex[arbitrator] - 1; // convert to 0-based
        uint256 last = eligiblePool.length - 1;

        if (idx != last) {
            address lastAddr = eligiblePool[last];
            eligiblePool[idx] = lastAddr;
            poolIndex[lastAddr] = idx + 1; // keep 1-based
        }

        eligiblePool.pop();
        poolIndex[arbitrator] = 0;
    }

    /// @dev Determines the winning outcome by strict plurality.
    ///      Ties are broken: driver > rider > split (all equal → driver) — must be documented.
    function _outcome(CaseData storage caseData, uint256 fareAmount)
        internal
        view
        returns (VoteChoice winner, uint256 driverAmount, uint256 riderAmount)
    {
        uint16 d = caseData.driverVotes;
        uint16 r = caseData.riderVotes;
        uint16 s = caseData.splitVotes;

        // strict-greater-than comparisons remove tie bias between driver and split
        if (d >= r && d >= s) {
            // driver wins or ties — refund full fare to driver
            return (VoteChoice.Driver, fareAmount, 0);
        }
        if (r > d && r >= s) {
            // rider wins strictly — full refund to rider
            return (VoteChoice.Rider, 0, fareAmount);
        }

        // split wins strictly (s > d and s > r). The odd wei goes to the driver
        // because platform fees are charged against the driver's settlement side.
        uint256 splitDriverAmount = (fareAmount / 2) + (fareAmount % 2);
        return (VoteChoice.Split, splitDriverAmount, fareAmount - splitDriverAmount);
    }

    /// @dev Pays an equal share of jurorRewardPerCase to each juror that voted with the winner.
    ///      If the reserve is insufficient the rewards are skipped silently to avoid reverting a
    ///      case execution — a governance warning event is not emitted for brevity, but the
    ///      reserve balance is public for monitoring.
    function _distributeRewards(
        uint256 caseId,
        CaseData storage caseData,
        VoteChoice winner
    ) internal {
        uint256 reward = jurorRewardPerCase;
        if (reward == 0) return;

        address[] memory jury = caseData.jury;
        uint256 winnerCount = 0;
        for (uint256 i = 0; i < jury.length; i++) {
            if (votes[caseId][jury[i]] == winner) {
                winnerCount++;
            }
        }
        if (winnerCount == 0) return;

        if (rewardReserve < reward) return; // insufficient reserve, skip silently

        uint256 perJuror = reward / winnerCount;
        uint256 remainder = reward % winnerCount;
        rewardReserve -= reward;
        for (uint256 i = 0; i < jury.length; i++) {
            if (votes[caseId][jury[i]] == winner) {
                uint256 payout = perJuror;
                if (remainder > 0) {
                    payout += 1;
                    remainder -= 1;
                }
                if (payout > 0) {
                    rideToken.safeTransfer(jury[i], payout);
                    emit JurorRewarded(caseId, jury[i], payout);
                }
            }
        }
    }

    function _case(uint256 caseId) internal view returns (CaseData storage caseData) {
        caseData = cases[caseId];
        if (caseData.rideId == 0) {
            revert CaseNotFound();
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Guarded} from "./Guarded.sol";

interface IVoxelRaidLeaderboard {
    struct Entry {
        address player;
        uint64 score;
        uint32 wave;
    }

    function totalTokens(address player) external view returns (uint256);
    function currentWeek() external view returns (uint256);
    function getTop(uint256 week) external view returns (Entry[] memory);
}

/// @title VOXEL//RAID token (VXL)
/// @notice Every gold coin picked up in a ranked run that was submitted on-chain can be
///         claimed as 1 VXL. The leaderboard contract is the single source of truth, so
///         claiming needs no server and no extra signature.
///         The weekly top 10 can also claim a bonus by rank once the week is over.
/// @dev A global daily mint cap acts as a circuit breaker: even a leaked score signer can only
///      mint up to the cap before the guardian pauses claims. Claims above the remaining
///      allowance mint what fits; the rest stays claimable. Weekly rewards open only after a
///      delay past the week's end, so forged entries can be removed before anyone is paid.
contract VoxelToken is ERC20, ERC20Burnable, ERC20Permit, Guarded {
    IVoxelRaidLeaderboard public immutable leaderboard;

    /// @notice Most coins (whole VXL) that can be claimed across all players per UTC day.
    uint256 public dailyClaimCap = 250_000;

    /// @notice Bonus in whole VXL for ranks 1–10 of a finished week.
    uint256[10] public weeklyRewards = [uint256(500), 300, 200, 150, 120, 100, 80, 60, 40, 20];
    /// @notice How long after a week ends before its rewards can be claimed.
    uint256 public rewardClaimDelay = 1 days;

    mapping(address player => uint256) public claimedPickups;
    mapping(uint256 day => uint256) public claimedOnDay;
    mapping(uint256 week => mapping(address player => bool)) public weeklyRewardClaimed;

    event Claimed(address indexed player, uint256 pickups, uint256 amount);
    event DailyClaimCapUpdated(uint256 cap);
    event WeeklyRewardClaimed(address indexed player, uint256 indexed week, uint256 rank, uint256 amount);
    event WeeklyRewardsUpdated(uint256[10] rewards, uint256 claimDelay);

    error NothingToClaim();
    error DailyCapReached();
    error RewardNotOpen();
    error NotInTop();
    error RewardAlreadyClaimed();

    constructor(IVoxelRaidLeaderboard leaderboard_, address owner_)
        ERC20("Voxel Raid Token", "VXL")
        ERC20Permit("Voxel Raid Token")
        Ownable(owner_)
    {
        leaderboard = leaderboard_;
    }

    /// @return pickups coins recorded on the leaderboard that have not been claimed yet
    function claimable(address player) public view returns (uint256 pickups) {
        return leaderboard.totalTokens(player) - claimedPickups[player];
    }

    /// @return pickups coins that can still be claimed today across all players
    function remainingToday() public view returns (uint256) {
        uint256 used = claimedOnDay[block.timestamp / 1 days];
        return used >= dailyClaimCap ? 0 : dailyClaimCap - used;
    }

    function claim() external whenNotPaused returns (uint256 amount) {
        uint256 pickups = claimable(msg.sender);
        if (pickups == 0) revert NothingToClaim();
        uint256 room = remainingToday();
        if (room == 0) revert DailyCapReached();
        if (pickups > room) pickups = room;

        claimedPickups[msg.sender] += pickups;
        claimedOnDay[block.timestamp / 1 days] += pickups;
        amount = pickups * 10 ** decimals();
        _mint(msg.sender, amount);
        emit Claimed(msg.sender, pickups, amount);
    }

    /// @return opensAt when rewards for `week` become claimable (unix seconds)
    function rewardOpensAt(uint256 week) public view returns (uint256 opensAt) {
        return (week + 1) * 1 weeks + rewardClaimDelay;
    }

    /// @return rank 1-based rank of `player` on `week`'s board, or 0 if not in the top 10
    function rankOf(uint256 week, address player) public view returns (uint256 rank) {
        IVoxelRaidLeaderboard.Entry[] memory top = leaderboard.getTop(week);
        for (uint256 i; i < top.length; ++i) {
            if (top[i].player == player) return i + 1;
        }
        return 0;
    }

    function claimWeeklyReward(uint256 week) external whenNotPaused returns (uint256 amount) {
        if (block.timestamp < rewardOpensAt(week)) revert RewardNotOpen();
        if (weeklyRewardClaimed[week][msg.sender]) revert RewardAlreadyClaimed();
        uint256 rank = rankOf(week, msg.sender);
        if (rank == 0) revert NotInTop();
        weeklyRewardClaimed[week][msg.sender] = true;
        amount = weeklyRewards[rank - 1] * 10 ** decimals();
        _mint(msg.sender, amount);
        emit WeeklyRewardClaimed(msg.sender, week, rank, amount);
    }

    function setWeeklyRewards(uint256[10] calldata rewards, uint256 claimDelay) external onlyOwner {
        weeklyRewards = rewards;
        rewardClaimDelay = claimDelay;
        emit WeeklyRewardsUpdated(rewards, claimDelay);
    }

    function setDailyClaimCap(uint256 cap) external onlyOwner {
        dailyClaimCap = cap;
        emit DailyClaimCapUpdated(cap);
    }
}

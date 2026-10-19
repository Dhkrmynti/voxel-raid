// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Guarded} from "./Guarded.sol";

interface IVoxelRaidLeaderboard {
    function totalTokens(address player) external view returns (uint256);
}

/// @title VOXEL//RAID token (VXL)
/// @notice Every gold coin picked up in a ranked run that was submitted on-chain can be
///         claimed as 1 VXL. The leaderboard contract is the single source of truth, so
///         claiming needs no server and no extra signature.
/// @dev A global daily mint cap acts as a circuit breaker: even a leaked score signer can only
///      mint up to the cap before the guardian pauses claims. Claims above the remaining
///      allowance mint what fits; the rest stays claimable.
contract VoxelToken is ERC20, ERC20Burnable, ERC20Permit, Guarded {
    IVoxelRaidLeaderboard public immutable leaderboard;

    /// @notice Most coins (whole VXL) that can be claimed across all players per UTC day.
    uint256 public dailyClaimCap = 250_000;

    mapping(address player => uint256) public claimedPickups;
    mapping(uint256 day => uint256) public claimedOnDay;

    event Claimed(address indexed player, uint256 pickups, uint256 amount);
    event DailyClaimCapUpdated(uint256 cap);

    error NothingToClaim();
    error DailyCapReached();

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

    function setDailyClaimCap(uint256 cap) external onlyOwner {
        dailyClaimCap = cap;
        emit DailyClaimCapUpdated(cap);
    }
}

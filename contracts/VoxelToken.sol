// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

interface IVoxelRaidLeaderboard {
    function totalTokens(address player) external view returns (uint256);
}

/// @title VOXEL//RAID token (VXL)
/// @notice Every gold coin picked up in a ranked run that was submitted on-chain can be
///         claimed as 1 VXL. The leaderboard contract is the single source of truth, so
///         claiming needs no server and no extra signature.
contract VoxelToken is ERC20, ERC20Burnable, ERC20Permit {
    IVoxelRaidLeaderboard public immutable leaderboard;

    mapping(address player => uint256) public claimedPickups;

    event Claimed(address indexed player, uint256 pickups, uint256 amount);

    error NothingToClaim();

    constructor(IVoxelRaidLeaderboard leaderboard_) ERC20("Voxel Raid Token", "VXL") ERC20Permit("Voxel Raid Token") {
        leaderboard = leaderboard_;
    }

    /// @return pickups coins recorded on the leaderboard that have not been claimed yet
    function claimable(address player) public view returns (uint256 pickups) {
        return leaderboard.totalTokens(player) - claimedPickups[player];
    }

    function claim() external returns (uint256 amount) {
        uint256 pickups = claimable(msg.sender);
        if (pickups == 0) revert NothingToClaim();
        claimedPickups[msg.sender] += pickups;
        amount = pickups * 10 ** decimals();
        _mint(msg.sender, amount);
        emit Claimed(msg.sender, pickups, amount);
    }
}

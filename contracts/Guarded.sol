// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Shared emergency controls for the VOXEL//RAID contracts
/// @notice The owner (meant to be a multisig) controls configuration and can unpause.
///         A separate guardian key can only pause — so incident response can be fast
///         without giving a hot key any power to change or drain anything.
///         Ownership moves in two steps, so a mistyped multisig address can't lock the contract.
abstract contract Guarded is Ownable2Step, Pausable {
    address public guardian;

    event GuardianUpdated(address indexed guardian);

    error NotGuardianOrOwner();

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title VOXEL//RAID weekly leaderboard
/// @notice Players submit their own scores, but every score must carry an EIP-712
///         attestation from the game server, which validated the run off-chain.
///         Each attested game session can only be used once.
contract VoxelRaidLeaderboard is EIP712, Ownable {
    struct Entry {
        address player;
        uint64 score;
        uint32 wave;
    }

    bytes32 public constant SCORE_TYPEHASH = keccak256(
        "Score(address player,uint64 score,uint32 wave,uint32 kills,uint32 tokens,bytes32 sessionId,uint64 deadline)"
    );
    uint256 public constant TOP_N = 10;

    address public signer;

    mapping(bytes32 sessionId => bool) public usedSessions;
    mapping(uint256 week => mapping(address player => uint64)) public bestScore;
    mapping(address player => uint256) public totalTokens;
    mapping(address player => uint256) public gamesSubmitted;
    mapping(uint256 week => Entry[]) private _top;

    event ScoreSubmitted(
        address indexed player,
        uint256 indexed week,
        uint64 score,
        uint32 wave,
        uint32 kills,
        uint32 tokens,
        bytes32 sessionId
    );
    event SignerUpdated(address indexed signer);

    error AttestationExpired();
    error SessionAlreadyUsed();
    error InvalidAttestation();
    error ZeroAddress();

    constructor(address signer_, address owner_) EIP712("VoxelRaid", "1") Ownable(owner_) {
        _setSigner(signer_);
    }

    /// @notice Weeks are counted since the unix epoch (week boundaries fall on Thursday 00:00 UTC).
    function currentWeek() public view returns (uint256) {
        return block.timestamp / 1 weeks;
    }

    function submitScore(
        uint64 score,
        uint32 wave,
        uint32 kills,
        uint32 tokens,
        bytes32 sessionId,
        uint64 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert AttestationExpired();
        if (usedSessions[sessionId]) revert SessionAlreadyUsed();

        bytes32 structHash =
            keccak256(abi.encode(SCORE_TYPEHASH, msg.sender, score, wave, kills, tokens, sessionId, deadline));
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != signer) revert InvalidAttestation();

        usedSessions[sessionId] = true;
        totalTokens[msg.sender] += tokens;
        gamesSubmitted[msg.sender] += 1;

        uint256 week = currentWeek();
        if (score > bestScore[week][msg.sender]) {
            bestScore[week][msg.sender] = score;
            _updateTop(week, msg.sender, score, wave);
        }
        emit ScoreSubmitted(msg.sender, week, score, wave, kills, tokens, sessionId);
    }

    function getTop(uint256 week) external view returns (Entry[] memory) {
        return _top[week];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function setSigner(address signer_) external onlyOwner {
        _setSigner(signer_);
    }

    function _setSigner(address signer_) private {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerUpdated(signer_);
    }

    /// @dev Only called when `score` beats the player's previous best this week,
    ///      so an existing entry for the player can simply be overwritten and bubbled up.
    function _updateTop(uint256 week, address player, uint64 score, uint32 wave) private {
        Entry[] storage top = _top[week];
        uint256 len = top.length;
        uint256 i = len;
        for (uint256 j; j < len; ++j) {
            if (top[j].player == player) {
                i = j;
                break;
            }
        }
        if (i == len) {
            if (len < TOP_N) {
                top.push();
            } else if (score <= top[len - 1].score) {
                return;
            } else {
                i = len - 1;
            }
        }
        top[i] = Entry(player, score, wave);
        // Strict comparison: on ties the earlier submission keeps the higher rank.
        while (i > 0 && top[i - 1].score < top[i].score) {
            Entry memory above = top[i - 1];
            top[i - 1] = top[i];
            top[i] = above;
            --i;
        }
    }
}

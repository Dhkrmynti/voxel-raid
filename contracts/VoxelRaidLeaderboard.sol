// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Guarded} from "./Guarded.sol";

/// @title VOXEL//RAID weekly leaderboard
/// @notice Players submit their own scores, but every score must carry an EIP-712
///         attestation from the game server, which re-simulated the run off-chain.
///         Each attested game session can only be used once.
/// @dev Defence in depth against a leaked signer key: per-run caps bound what one forged
///      attestation can claim, the guardian can pause submissions at once, the owner can
///      rotate the signer and remove forged entries.
contract VoxelRaidLeaderboard is EIP712, Guarded {
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
    /// @notice Upper bounds for a single run. Far above anything the game produces, low enough
    ///         that one forged attestation can't top the board absurdly or mint a fortune.
    uint64 public maxScorePerRun = 50_000_000;
    uint32 public maxTokensPerRun = 5_000;

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
    event RunCapsUpdated(uint64 maxScorePerRun, uint32 maxTokensPerRun);
    event EntryRemoved(uint256 indexed week, address indexed player);

    error AttestationExpired();
    error SessionAlreadyUsed();
    error InvalidAttestation();
    error RunOverCap();
    error ZeroAddress();
    error EntryNotFound();

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
    ) external whenNotPaused {
        if (block.timestamp > deadline) revert AttestationExpired();
        if (usedSessions[sessionId]) revert SessionAlreadyUsed();
        if (score > maxScorePerRun || tokens > maxTokensPerRun) revert RunOverCap();

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

    // ---------- owner ----------

    function setSigner(address signer_) external onlyOwner {
        _setSigner(signer_);
    }

    function setRunCaps(uint64 maxScore, uint32 maxTokens) external onlyOwner {
        maxScorePerRun = maxScore;
        maxTokensPerRun = maxTokens;
        emit RunCapsUpdated(maxScore, maxTokens);
    }

    /// @notice Incident response: drops a forged entry from a week's board. The freed slot is
    ///         not back-filled (scores below the top 10 are not stored on-chain).
    function removeEntry(uint256 week, address player) external onlyOwner {
        Entry[] storage top = _top[week];
        uint256 len = top.length;
        uint256 i;
        while (i < len && top[i].player != player) ++i;
        if (i == len) revert EntryNotFound();
        for (; i + 1 < len; ++i) top[i] = top[i + 1];
        top.pop();
        bestScore[week][player] = 0;
        emit EntryRemoved(week, player);
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

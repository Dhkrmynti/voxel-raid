// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Guarded} from "./Guarded.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title VOXEL//RAID Arsenal
/// @notice Cosmetic weapon skins as ERC-721 tokens, bought by burning VXL.
///         Artwork and metadata are generated fully on-chain.
///         Purchases can be paused by the guardian or owner (see Guarded).
contract VoxelArsenal is ERC721Enumerable, Guarded {
    using Strings for uint256;

    struct Item {
        string name;
        uint96 price; // in VXL wei
        uint24 body;
        uint24 accent;
        uint24 glow;
        bool active;
    }

    ERC20Burnable public immutable token;

    Item[] private _items;
    mapping(uint256 tokenId => uint256) public itemOf;
    uint256 private _nextTokenId = 1;

    event ItemListed(uint256 indexed itemId, string name, uint256 price);
    event ItemUpdated(uint256 indexed itemId, uint256 price, bool active);
    event Purchased(address indexed buyer, uint256 indexed itemId, uint256 indexed tokenId, uint256 price);

    error UnknownItem();
    error ItemInactive();
    error InvalidName();
    error PriceAboveMax(uint256 price, uint256 maxPrice);

    constructor(ERC20Burnable token_, address owner_) ERC721("Voxel Raid Arsenal", "VXARS") Ownable(owner_) {
        token = token_;
    }

    // ---------- catalog ----------

    function addItem(string calldata name, uint96 price, uint24 body, uint24 accent, uint24 glow)
        external
        onlyOwner
        returns (uint256 itemId)
    {
        _checkName(name);
        itemId = _items.length;
        _items.push(Item(name, price, body, accent, glow, true));
        emit ItemListed(itemId, name, price);
    }

    function setItem(uint256 itemId, uint96 price, bool active) external onlyOwner {
        Item storage it = _item(itemId);
        it.price = price;
        it.active = active;
        emit ItemUpdated(itemId, price, active);
    }

    function items() external view returns (Item[] memory) {
        return _items;
    }

    /// @return itemIds the item id of every token `owner` holds, in index order
    function ownedItems(address owner) external view returns (uint256[] memory itemIds) {
        uint256 n = balanceOf(owner);
        itemIds = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            itemIds[i] = itemOf[tokenOfOwnerByIndex(owner, i)];
        }
    }

    // ---------- purchase ----------

    /// @notice Buy with a prior `approve`. `maxPrice` is the price the buyer saw: if the owner
    /// raises it before the transaction lands, the purchase reverts instead of burning more.
    function buy(uint256 itemId, uint256 maxPrice) external returns (uint256) {
        return _purchase(itemId, maxPrice);
    }

    /// @notice Buy with an EIP-2612 permit for `maxPrice`, so no separate approve transaction is needed.
    function buyWithPermit(uint256 itemId, uint256 maxPrice, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (uint256)
    {
        // A front-runner may already have submitted this permit; the allowance is what matters.
        try IERC20Permit(address(token)).permit(msg.sender, address(this), maxPrice, deadline, v, r, s) {}
            catch {}
        return _purchase(itemId, maxPrice);
    }

    function _purchase(uint256 itemId, uint256 maxPrice) private whenNotPaused returns (uint256 tokenId) {
        Item storage it = _item(itemId);
        if (!it.active) revert ItemInactive();
        if (it.price > maxPrice) revert PriceAboveMax(it.price, maxPrice);
        token.burnFrom(msg.sender, it.price);
        tokenId = _nextTokenId++;
        itemOf[tokenId] = itemId;
        _mint(msg.sender, tokenId);
        emit Purchased(msg.sender, itemId, tokenId, it.price);
    }

    // ---------- metadata ----------

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        uint256 itemId = itemOf[tokenId];
        string memory name = _items[itemId].name;
        string memory head = string.concat('{"name":"', name, " #", tokenId.toString(), '",');
        string memory image = string.concat(
            '"description":"Skin senjata kosmetik untuk VOXEL//RAID.","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg(itemId))),
            '",'
        );
        string memory attrs = string.concat('"attributes":[{"trait_type":"Skin","value":"', name, '"}]}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(string.concat(head, image, attrs))));
    }

    /// @notice Pixel-art side view of the gun in the item's colors.
    function svg(uint256 itemId) public view returns (string memory) {
        Item storage it = _item(itemId);
        string memory body = _hex(it.body);
        string memory accent = _hex(it.accent);
        string memory glow = _hex(it.glow);
        string memory front = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">',
            '<rect width="24" height="24" fill="#120a24"/>',
            _rect(1, 10, 6, 2, "#1a1a24"),
            _rect(0, 10, 1, 2, glow),
            _rect(6, 9, 12, 4, body)
        );
        string memory back = string.concat(
            _rect(6, 9, 12, 1, glow),
            _rect(9, 8, 2, 1, accent),
            _rect(18, 10, 4, 4, body),
            _rect(14, 13, 3, 5, "#1a1a24"),
            _rect(12, 13, 1, 2, accent)
        );
        return string.concat(front, back, "</svg>");
    }

    // ---------- internals ----------

    function _item(uint256 itemId) private view returns (Item storage) {
        if (itemId >= _items.length) revert UnknownItem();
        return _items[itemId];
    }

    /// @dev Names end up inside JSON, so only A-Z, 0-9, space and dash are allowed.
    function _checkName(string calldata name) private pure {
        bytes calldata b = bytes(name);
        if (b.length == 0 || b.length > 24) revert InvalidName();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == " " || c == "-";
            if (!ok) revert InvalidName();
        }
    }

    function _rect(uint256 x, uint256 y, uint256 w, uint256 h, string memory fill) private pure returns (string memory) {
        return string.concat(
            '<rect x="',
            x.toString(),
            '" y="',
            y.toString(),
            '" width="',
            w.toString(),
            '" height="',
            h.toString(),
            '" fill="',
            fill,
            '"/>'
        );
    }

    function _hex(uint24 color) private pure returns (string memory) {
        bytes memory out = new bytes(7);
        bytes16 digits = "0123456789abcdef";
        out[0] = "#";
        for (uint256 i; i < 6; ++i) {
            out[6 - i] = digits[(uint256(color) >> (4 * i)) & 0xf];
        }
        return string(out);
    }
}

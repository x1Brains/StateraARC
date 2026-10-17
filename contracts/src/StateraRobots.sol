// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Statera Robots — the Arc Elite citizenship NFT (4,444).
/// @notice Mint price follows a straight line from $8 (Robot #1) to $44
///         (Robot #4,444), paid in Arc USDC to the treasury. Every mint pays
///         the minter 10,000 STR from this contract's STR balance (the 50%
///         Robots allocation). One mint per wallet — the same rule as Brains
///         Elites on X1; Robots can still be bought on secondary.
///         The handle chosen at mint is emitted for the bridge keeper, which
///         registers the Robot as an X1 citizen (same flow as the Arc
///         citizenship NFT v3).
/// @dev Enumerable so the site can list a wallet's Robots on-chain (claim /
///      finish-registration panels, mirror of the SVM credential flow).
contract StateraRobots is ERC721Enumerable, ERC2981, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    uint256 public constant MAX_SUPPLY    = 4_444;
    /// @notice USDC has 6 decimals: $8.00 and $44.00.
    uint256 public constant START_PRICE   = 8_000_000;
    uint256 public constant END_PRICE     = 44_000_000;
    /// @notice STR paid to the minter of each Robot (18 decimals).
    uint256 public constant STR_PER_ROBOT = 10_000e18;
    uint256 public constant MAX_HANDLE_LEN = 32;
    uint96  public constant ROYALTY_BPS   = 500; // 5% resale royalty

    IERC20 public immutable usdc;
    IERC20 public immutable str;

    address public treasury;
    uint256 public totalMinted;
    bool public mintPaused;
    /// @notice Once true the art/metadata link can never change again (one-way).
    bool public metadataLocked;
    string private baseURI_;

    /// @notice A wallet that already minted cannot mint again.
    mapping(address => bool) public hasMinted;
    /// @notice Which of the 4,444 robot designs (1..4444) each token got. Drawn at random AT MINT, shown instantly.
    mapping(uint256 => uint256) public artOf;
    /// @dev Lazy Fisher-Yates over the designs not yet drawn (0 = untouched slot = its own index).
    mapping(uint256 => uint256) private _pool;

    event Minted(address indexed to, uint256 indexed tokenId, uint256 pricePaid, string handle);
    event MintPausedUpdated(bool paused);
    event BaseURIUpdated(string newBaseURI);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event MetadataLocked(string baseURI);

    error ZeroAddress();
    error Paused();
    error SoldOut();
    error AlreadyMinted();
    error PriceAboveMax(uint256 price, uint256 maxPrice);
    error BadHandle();
    error StrAllocationEmpty();
    error MetadataIsLocked();
    error RenounceDisabled();

    constructor(address owner_, IERC20 usdc_, IERC20 str_, address treasury_, string memory baseURI)
        ERC721("Statera Robots", "X1CITY")
        Ownable(owner_)
    {
        if (address(usdc_) == address(0) || address(str_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        str = str_;
        treasury = treasury_;
        baseURI_ = baseURI;
        _setDefaultRoyalty(treasury_, ROYALTY_BPS);
    }

    // ------------------------------------------------------------------ price

    /// @notice Price of Robot number `n` (1-based) in USDC atomic units.
    function priceOf(uint256 n) public pure returns (uint256) {
        if (n == 0 || n > MAX_SUPPLY) revert SoldOut();
        return START_PRICE + ((END_PRICE - START_PRICE) * (n - 1)) / (MAX_SUPPLY - 1);
    }

    /// @notice What the next mint costs right now.
    function currentPrice() external view returns (uint256) {
        return priceOf(totalMinted + 1);
    }

    // ------------------------------------------------------------------- mint

    /// @notice Mint one Robot. Approve `currentPrice()` USDC to this contract
    ///         first. `maxPrice` protects you if someone mints just before you.
    function mint(string calldata handle, uint256 maxPrice) external nonReentrant returns (uint256 tokenId) {
        if (mintPaused) revert Paused();
        if (totalMinted >= MAX_SUPPLY) revert SoldOut();
        if (hasMinted[msg.sender]) revert AlreadyMinted();
        uint256 len = bytes(handle).length;
        if (len == 0 || len > MAX_HANDLE_LEN) revert BadHandle();

        tokenId = totalMinted + 1;
        uint256 price = priceOf(tokenId);
        if (price > maxPrice) revert PriceAboveMax(price, maxPrice);
        if (str.balanceOf(address(this)) < STR_PER_ROBOT) revert StrAllocationEmpty();

        hasMinted[msg.sender] = true;
        totalMinted = tokenId;
        artOf[tokenId] = _draw(tokenId);

        usdc.safeTransferFrom(msg.sender, treasury, price);
        _safeMint(msg.sender, tokenId);
        str.safeTransfer(msg.sender, STR_PER_ROBOT);

        emit Minted(msg.sender, tokenId, price, handle);
    }

    /// @dev Random design from those left, never repeats. Mixes the block's randomness, the previous block hash,
    ///      the minter and the count, so nobody can know which robot the next mint gives.
    function _draw(uint256 tokenId) private returns (uint256) {
        uint256 left = MAX_SUPPLY - (tokenId - 1);
        uint256 r = uint256(keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), msg.sender, tokenId, block.timestamp))) % left;
        uint256 pick = _pool[r] == 0 ? r : _pool[r] - 1;
        uint256 last = _pool[left - 1] == 0 ? left - 1 : _pool[left - 1] - 1;
        _pool[r] = last + 1;
        return pick + 1;
    }

    // ------------------------------------------------------------------ owner

    function setMintPaused(bool paused) external onlyOwner {
        mintPaused = paused;
        emit MintPausedUpdated(paused);
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        if (metadataLocked) revert MetadataIsLocked();
        baseURI_ = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    /// @notice Freeze the art/metadata forever (marketplaces show it as frozen). Cannot be undone.
    function lockMetadata() external onlyOwner {
        metadataLocked = true;
        emit MetadataLocked(baseURI_);
    }

    /// @notice Give up ownership forever — allowed ONLY when it's safe (owner 10-16):
    ///         the art is locked (permanently frozen) AND minting is not paused (it can never get stuck shut).
    ///         After this nobody can pause, change the treasury or touch the metadata ever again.
    function renounceOwnership() public override onlyOwner {
        if (!metadataLocked || mintPaused) revert RenounceDisabled();
        super.renounceOwnership();
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
        _setDefaultRoyalty(newTreasury, ROYALTY_BPS);
    }

    // ----------------------------------------------------------------- views

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return bytes(baseURI_).length == 0 ? "" : string.concat(baseURI_, artOf[tokenId].toString(), ".json");
    }

    /// @notice Designs drawn by tokens [start, start+count) — one call for the site's 4,444-tile board (0 = not minted yet).
    function artsOf(uint256 start, uint256 count) external view returns (uint256[] memory out) {
        out = new uint256[](count);
        for (uint256 i; i < count; i++) out[i] = artOf[start + i];
    }

    /// @notice STR still waiting for future mints.
    function strRemaining() external view returns (uint256) {
        return str.balanceOf(address(this));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721Enumerable, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}

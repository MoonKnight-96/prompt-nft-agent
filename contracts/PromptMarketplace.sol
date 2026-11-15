// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PromptMarketplace
/// @notice Fixed-price marketplace for PromptNFTs. Sellers keep their NFT until
///         it sells (approval-based listing, no escrow). Payments use the pull
///         pattern: seller, creator royalty and platform fee are credited and
///         each party withdraws.
contract PromptMarketplace is Ownable, ReentrancyGuard {
    uint96 public constant MAX_FEE_BPS = 500; // 5%

    struct Listing {
        address seller;
        uint256 price;
    }

    IERC721 public immutable nft;
    uint96 public feeBps;
    address public feeRecipient;

    mapping(uint256 => Listing) public listings;
    mapping(address => uint256) public proceeds;

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event Cancelled(uint256 indexed tokenId, address indexed seller);
    event Sold(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        uint256 price,
        uint256 royalty,
        uint256 fee
    );
    event Withdrawn(address indexed account, uint256 amount);
    event FeeUpdated(uint96 feeBps, address feeRecipient);

    error NotTokenOwner();
    error NotApproved();
    error ZeroPrice();
    error NotListed();
    error ListingStale();
    error WrongPayment(uint256 sent, uint256 price);
    error BuyerIsSeller();
    error NothingToWithdraw();
    error TransferFailed();
    error FeeTooHigh(uint96 requested, uint96 maximum);

    constructor(address nftAddress, uint96 initialFeeBps, address initialFeeRecipient)
        Ownable(msg.sender)
    {
        nft = IERC721(nftAddress);
        _setFee(initialFeeBps, initialFeeRecipient);
    }

    function list(uint256 tokenId, uint256 price) external {
        if (price == 0) revert ZeroPrice();
        if (nft.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (
            nft.getApproved(tokenId) != address(this)
                && !nft.isApprovedForAll(msg.sender, address(this))
        ) revert NotApproved();

        listings[tokenId] = Listing(msg.sender, price);
        emit Listed(tokenId, msg.sender, price);
    }

    function cancel(uint256 tokenId) external {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        // The seller, or anyone once the seller no longer owns the token.
        if (msg.sender != l.seller && nft.ownerOf(tokenId) == l.seller) revert NotTokenOwner();
        delete listings[tokenId];
        emit Cancelled(tokenId, l.seller);
    }

    function buy(uint256 tokenId) external payable nonReentrant {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed();
        if (msg.value != l.price) revert WrongPayment(msg.value, l.price);
        if (msg.sender == l.seller) revert BuyerIsSeller();
        if (nft.ownerOf(tokenId) != l.seller) revert ListingStale();

        delete listings[tokenId];

        uint256 fee = (l.price * feeBps) / 10_000;
        uint256 royalty;
        address royaltyReceiver;
        try IERC2981(address(nft)).royaltyInfo(tokenId, l.price) returns (address r, uint256 amt) {
            royaltyReceiver = r;
            royalty = amt;
        } catch {}
        // The creator selling their own prompt pays no royalty to themselves.
        if (royaltyReceiver == l.seller || royaltyReceiver == address(0)) royalty = 0;
        if (royalty + fee > l.price) royalty = l.price - fee;

        proceeds[l.seller] += l.price - royalty - fee;
        if (royalty > 0) proceeds[royaltyReceiver] += royalty;
        if (fee > 0) proceeds[feeRecipient] += fee;

        nft.safeTransferFrom(l.seller, msg.sender, tokenId);
        emit Sold(tokenId, l.seller, msg.sender, l.price, royalty, fee);
    }

    function withdraw() external nonReentrant {
        uint256 amount = proceeds[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        proceeds[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function setFee(uint96 newFeeBps, address newRecipient) external onlyOwner {
        _setFee(newFeeBps, newRecipient);
    }

    function _setFee(uint96 newFeeBps, address newRecipient) private {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        feeBps = newFeeBps;
        feeRecipient = newRecipient == address(0) ? msg.sender : newRecipient;
        emit FeeUpdated(feeBps, feeRecipient);
    }
}

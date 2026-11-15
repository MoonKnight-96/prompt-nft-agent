// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

/// @title PromptNFT
/// @notice Each token represents one AI prompt. The token URI points to public
///         metadata (title, description, model, sample output) plus an
///         encrypted copy of the prompt. Only the current owner can unlock it.
/// @dev promptHash is keccak256 of the normalized prompt text. It blocks exact
///      duplicates without revealing the prompt.
contract PromptNFT is ERC721URIStorage, ERC2981 {
    uint96 public constant MAX_ROYALTY_BPS = 1000; // 10%

    uint256 private _nextId = 1;

    mapping(uint256 => address) public creatorOf;
    mapping(bytes32 => uint256) public tokenByPromptHash;

    event PromptMinted(
        uint256 indexed tokenId,
        address indexed creator,
        bytes32 indexed promptHash,
        string tokenURI,
        uint96 royaltyBps
    );

    error DuplicatePrompt(uint256 existingTokenId);
    error RoyaltyTooHigh(uint96 requested, uint96 maximum);
    error EmptyURI();
    error EmptyHash();

    constructor() ERC721("Prompt NFT", "PROMPT") {}

    /// @notice Mint a new prompt NFT to the caller.
    /// @param uri         IPFS URI of the metadata JSON.
    /// @param promptHash  keccak256 of the normalized prompt text.
    /// @param royaltyBps  Creator royalty on resales, in basis points (500 = 5%).
    function mint(string calldata uri, bytes32 promptHash, uint96 royaltyBps)
        external
        returns (uint256 tokenId)
    {
        if (bytes(uri).length == 0) revert EmptyURI();
        if (promptHash == bytes32(0)) revert EmptyHash();
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(royaltyBps, MAX_ROYALTY_BPS);
        uint256 existing = tokenByPromptHash[promptHash];
        if (existing != 0) revert DuplicatePrompt(existing);

        tokenId = _nextId++;
        tokenByPromptHash[promptHash] = tokenId;
        creatorOf[tokenId] = msg.sender;

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);
        _setTokenRoyalty(tokenId, msg.sender, royaltyBps);

        emit PromptMinted(tokenId, msg.sender, promptHash, uri, royaltyBps);
    }

    /// @notice Number of prompts minted so far.
    function totalMinted() external view returns (uint256) {
        return _nextId - 1;
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, ERC2981)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}

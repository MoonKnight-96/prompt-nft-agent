const { expect } = require("chai");
const { ethers } = require("hardhat");

const hashOf = (text) => ethers.keccak256(ethers.toUtf8Bytes(text.trim().replace(/\s+/g, " ")));
const ETH = (n) => ethers.parseEther(n);

describe("PromptNFT", function () {
  let nft, creator, other;

  beforeEach(async () => {
    [creator, other] = await ethers.getSigners();
    nft = await ethers.deployContract("PromptNFT");
  });

  it("mints to the caller and records creator, URI and royalty", async () => {
    await expect(nft.mint("ipfs://meta1", hashOf("Write a haiku"), 500))
      .to.emit(nft, "PromptMinted")
      .withArgs(1, creator.address, hashOf("Write a haiku"), "ipfs://meta1", 500);
    expect(await nft.ownerOf(1)).to.equal(creator.address);
    expect(await nft.creatorOf(1)).to.equal(creator.address);
    expect(await nft.tokenURI(1)).to.equal("ipfs://meta1");
    const [receiver, amount] = await nft.royaltyInfo(1, ETH("1"));
    expect(receiver).to.equal(creator.address);
    expect(amount).to.equal(ETH("0.05"));
    expect(await nft.totalMinted()).to.equal(1);
  });

  it("rejects an exact duplicate prompt, even from another account", async () => {
    await nft.mint("ipfs://a", hashOf("Same prompt"), 0);
    await expect(nft.connect(other).mint("ipfs://b", hashOf("Same prompt"), 0))
      .to.be.revertedWithCustomError(nft, "DuplicatePrompt")
      .withArgs(1);
  });

  it("rejects royalty above 10%, empty URI and empty hash", async () => {
    await expect(nft.mint("ipfs://a", hashOf("x"), 1001)).to.be.revertedWithCustomError(nft, "RoyaltyTooHigh");
    await expect(nft.mint("", hashOf("x"), 0)).to.be.revertedWithCustomError(nft, "EmptyURI");
    await expect(nft.mint("ipfs://a", ethers.ZeroHash, 0)).to.be.revertedWithCustomError(nft, "EmptyHash");
  });

  it("supports ERC-721 and ERC-2981 interfaces", async () => {
    expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
    expect(await nft.supportsInterface("0x2a55205a")).to.equal(true); // ERC-2981
  });
});

describe("PromptMarketplace", function () {
  let nft, market, owner, creator, buyer, buyer2;

  beforeEach(async () => {
    [owner, creator, buyer, buyer2] = await ethers.getSigners();
    nft = await ethers.deployContract("PromptNFT");
    market = await ethers.deployContract("PromptMarketplace", [await nft.getAddress(), 250, owner.address]); // 2.5% fee
    await nft.connect(creator).mint("ipfs://p1", hashOf("Prompt one"), 500); // 5% royalty
    await nft.connect(creator).approve(await market.getAddress(), 1);
  });

  it("lists, sells and splits proceeds (first sale: no royalty to self)", async () => {
    await expect(market.connect(creator).list(1, ETH("1"))).to.emit(market, "Listed").withArgs(1, creator.address, ETH("1"));
    await expect(market.connect(buyer).buy(1, { value: ETH("1") }))
      .to.emit(market, "Sold")
      .withArgs(1, creator.address, buyer.address, ETH("1"), 0, ETH("0.025"));
    expect(await nft.ownerOf(1)).to.equal(buyer.address);
    expect(await market.proceeds(creator.address)).to.equal(ETH("0.975"));
    expect(await market.proceeds(owner.address)).to.equal(ETH("0.025"));
  });

  it("pays the creator royalty on resale", async () => {
    await market.connect(creator).list(1, ETH("1"));
    await market.connect(buyer).buy(1, { value: ETH("1") });

    await nft.connect(buyer).setApprovalForAll(await market.getAddress(), true);
    await market.connect(buyer).list(1, ETH("2"));
    await market.connect(buyer2).buy(1, { value: ETH("2") });

    expect(await nft.ownerOf(1)).to.equal(buyer2.address);
    expect(await market.proceeds(buyer.address)).to.equal(ETH("1.85")); // 2 - 0.10 royalty - 0.05 fee
    expect(await market.proceeds(creator.address)).to.equal(ETH("0.975") + ETH("0.1"));
  });

  it("lets each party withdraw their proceeds", async () => {
    await market.connect(creator).list(1, ETH("1"));
    await market.connect(buyer).buy(1, { value: ETH("1") });
    await expect(market.connect(creator).withdraw()).to.changeEtherBalance(creator, ETH("0.975"));
    await expect(market.connect(creator).withdraw()).to.be.revertedWithCustomError(market, "NothingToWithdraw");
  });

  it("rejects bad listings and purchases", async () => {
    await expect(market.connect(buyer).list(1, ETH("1"))).to.be.revertedWithCustomError(market, "NotTokenOwner");
    await expect(market.connect(creator).list(1, 0)).to.be.revertedWithCustomError(market, "ZeroPrice");
    await nft.connect(creator).approve(ethers.ZeroAddress, 1);
    await expect(market.connect(creator).list(1, ETH("1"))).to.be.revertedWithCustomError(market, "NotApproved");
    await nft.connect(creator).approve(await market.getAddress(), 1);
    await market.connect(creator).list(1, ETH("1"));
    await expect(market.connect(buyer).buy(1, { value: ETH("0.5") })).to.be.revertedWithCustomError(market, "WrongPayment");
    await expect(market.connect(creator).buy(1, { value: ETH("1") })).to.be.revertedWithCustomError(market, "BuyerIsSeller");
    await expect(market.connect(buyer).buy(2, { value: ETH("1") })).to.be.revertedWithCustomError(market, "NotListed");
  });

  it("blocks buying a stale listing and lets anyone clear it", async () => {
    await market.connect(creator).list(1, ETH("1"));
    await nft.connect(creator).transferFrom(creator.address, buyer2.address, 1); // seller gave it away
    await expect(market.connect(buyer).buy(1, { value: ETH("1") })).to.be.revertedWithCustomError(market, "ListingStale");
    await expect(market.connect(buyer).cancel(1)).to.emit(market, "Cancelled");
  });

  it("only the seller can cancel an active listing", async () => {
    await market.connect(creator).list(1, ETH("1"));
    await expect(market.connect(buyer).cancel(1)).to.be.revertedWithCustomError(market, "NotTokenOwner");
    await expect(market.connect(creator).cancel(1)).to.emit(market, "Cancelled").withArgs(1, creator.address);
  });

  it("caps the platform fee at 5% and restricts it to the owner", async () => {
    await expect(market.setFee(501, owner.address)).to.be.revertedWithCustomError(market, "FeeTooHigh");
    await expect(market.connect(buyer).setFee(100, buyer.address)).to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount");
  });
});

// Deploys PromptNFT + PromptMarketplace and writes addresses/ABIs for the web app and server.
const { ethers, network, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  const feeBps = Number(process.env.PLATFORM_FEE_BPS || 250); // 2.5% default
  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;

  console.log(`Network: ${network.name}  Deployer: ${deployer.address}`);

  const nft = await ethers.deployContract("PromptNFT");
  await nft.waitForDeployment();
  const market = await ethers.deployContract("PromptMarketplace", [await nft.getAddress(), feeBps, feeRecipient]);
  await market.waitForDeployment();

  const { chainId } = await ethers.provider.getNetwork();
  const out = {
    network: network.name,
    chainId: Number(chainId),
    promptNFT: await nft.getAddress(),
    marketplace: await market.getAddress(),
    deployedAt: new Date().toISOString(),
    abi: {
      promptNFT: (await artifacts.readArtifact("PromptNFT")).abi,
      marketplace: (await artifacts.readArtifact("PromptMarketplace")).abi,
    },
  };

  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`PromptNFT:   ${out.promptNFT}\nMarketplace: ${out.marketplace}\nSaved ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

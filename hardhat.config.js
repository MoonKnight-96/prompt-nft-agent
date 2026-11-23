require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const {
  SEPOLIA_RPC_URL, AMOY_RPC_URL, POLYGON_RPC_URL,
  DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY,
} = process.env;

// Adds a network only when its RPC URL and a deployer key are set in .env.
const net = (url, chainId) => (url && DEPLOYER_PRIVATE_KEY ? { url, accounts: [DEPLOYER_PRIVATE_KEY], chainId } : undefined);
const networks = { hardhat: {}, localhost: { url: "http://127.0.0.1:8545" } };
for (const [name, cfg] of Object.entries({
  sepolia: net(SEPOLIA_RPC_URL, 11155111), // Ethereum test network (portfolio demo)
  amoy: net(AMOY_RPC_URL, 80002), // Polygon test network: rehearse here first
  polygon: net(POLYGON_RPC_URL, 137), // Polygon mainnet: REAL money
})) if (cfg) networks[name] = cfg;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks,
  // One Etherscan API v2 key works for Etherscan and Polygonscan.
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
};

# Prompt NFT Market

Sell AI prompts as NFTs. Not images: the **prompt text itself** is the asset.

Buyers see a title, description, target model and a sample output. The prompt is
encrypted, and only the wallet that currently owns the NFT can unlock it. When the
NFT is resold, the new owner gets access, the previous owner loses it, and the
original creator earns a royalty.

## How it works

```
Creator ──prompt──▶ Server ──encrypt (AES-256-GCM)──▶ metadata JSON ──▶ IPFS / storage
   │                                                                     │
   └──mint(tokenURI, promptHash, royalty)──▶ PromptNFT (ERC-721 + ERC-2981)
                                                 │
Buyer ──buy(tokenId) + ETH──▶ PromptMarketplace ─┘  (fee + royalty + seller payout)

Owner ──signs "unlock #id" message──▶ Server checks signature + ownerOf(id) on-chain
                                       └──▶ decrypts and returns the prompt
```

| Part | What it does |
|---|---|
| `contracts/PromptNFT.sol` | ERC-721 token per prompt. Stores the creator, an ERC-2981 royalty (max 10%), and a hash of the normalized prompt that blocks exact duplicates. |
| `contracts/PromptMarketplace.sol` | Fixed-price listings without escrow. On sale it credits seller, creator royalty and platform fee (max 5%), paid out with a pull-based `withdraw()`. Reentrancy-guarded; stale listings can't be bought. |
| `server/` (FastAPI) | Encrypts each prompt with its own key (envelope encryption, bound to the prompt hash), stores metadata on IPFS via Pinata or locally, and unlocks prompts only after verifying a wallet signature and on-chain ownership. Single-use nonces stop replay. |
| `web/` | Plain HTML/JS + ethers.js. Browse, mint, list, buy, unlock, withdraw. |

## Security notes

- The prompt is never on-chain or in public metadata, only its ciphertext and a keccak256 hash.
- Unlock requires a fresh signed message (5-minute, single-use nonce) **and** `ownerOf(tokenId)` on-chain.
- The server never fetches arbitrary URLs from token metadata (IPFS or its own files only).
- Trade-off: the server holds the master key, so it's a trusted party. A decentralized version could use threshold encryption (for example Lit Protocol).
- The prompt hash blocks exact copies (ignoring whitespace), not paraphrases.

## Run locally

Requirements: Node 18+ and Python 3.9+.

```bash
npm install
python3 -m venv server/.venv && server/.venv/bin/pip install -r server/requirements.txt
cp .env.example .env        # then set MASTER_KEY (command is in the file)

npx hardhat test            # 11 contract tests
(cd server && .venv/bin/python -m pytest -q)   # 7 server tests

npx hardhat node                                   # terminal 1: local chain
npx hardhat run scripts/deploy.js --network localhost
(cd server && .venv/bin/uvicorn app:app --port 8000)   # terminal 2
server/.venv/bin/python scripts/e2e_local.py        # full mint → buy → unlock check
```

Open http://127.0.0.1:8000 and connect MetaMask to `localhost:8545` (chain 31337).

## Deploy to Sepolia (test network)

1. Make a **separate test wallet** in MetaMask and get free Sepolia ETH from a faucet.
2. In `.env`, set `SEPOLIA_RPC_URL` (Alchemy or Infura), `DEPLOYER_PRIVATE_KEY` (test wallet only),
   `NETWORK=sepolia`, `RPC_URL`, `PUBLIC_RPC_URL` (a public endpoint) and `PINATA_JWT`.
3. `npx hardhat run scripts/deploy.js --network sepolia`
4. Start the server and open the site.

## Tech

Solidity 0.8.24 · OpenZeppelin 5 · Hardhat · Python FastAPI · cryptography (AES-GCM) · web3.py · ethers.js v6 · IPFS (Pinata)

## Live on Sepolia (test network)

| Contract | Address |
|---|---|
| PromptNFT | [0xfB36315112a4f8b1104A3309DF435627cD44AACC](https://sepolia.etherscan.io/address/0xfB36315112a4f8b1104A3309DF435627cD44AACC) |
| PromptMarketplace | [0x1Ce65f2E9400bbF22154B8cfAF23eCeD6cDC125A](https://sepolia.etherscan.io/address/0x1Ce65f2E9400bbF22154B8cfAF23eCeD6cDC125A) |

`scripts/e2e_sepolia.py` runs the full flow live: encrypt and pin metadata to IPFS, mint, list,
a second wallet buys, the buyer unlocks the prompt and the seller is locked out, the seller withdraws.
First live run: [mint](https://sepolia.etherscan.io/tx/0x2aba19abe7edc5601a432b2f4ca1c1d75018ea9656c9b9d42040a48facae9b02),
[purchase](https://sepolia.etherscan.io/tx/0x39478676582993cf19c59f5b5e579f1cf8393aaf5e34c4df1f255a45b17822da).

## Hosting

`render.yaml` deploys the server and website to Render. Set the secret values (`MASTER_KEY`,
`RPC_URL`, `PINATA_JWT`, `PUBLIC_BASE_URL`) in the Render dashboard.

## Status

Testnet only. No real funds.

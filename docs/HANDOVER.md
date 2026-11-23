# PromptNFT: Operator Handover Guide (Polygon)

This guide is for the new owner and operator of PromptNFT. After the handover, **you own and run
everything**: the wallet, the contracts, the hosting, the keys, the money and the legal side. The
original author has no ongoing role.

Read the whole guide once before you start. Do the **Amoy test-network rehearsal (Part 3) before
any real-money step**.

---

## Part 1: Accounts you need (all in your own name)

| # | What | Used for | Notes |
|---|---|---|---|
| 1 | **Crypto wallet** (MetaMask; a hardware wallet such as Ledger is safer) | Deploys the contracts, owns the marketplace, receives platform fees | Write the recovery phrase on paper, store it offline. Anyone with it controls the business. Use one wallet for deploying/owning and keep it separate from day-to-day use. |
| 2 | **Indian exchange account** (e.g. CoinDCX, WazirX) with KYC | Buy POL for gas; convert fees to INR | Must be in your name for tax records. |
| 3 | **GitHub** | Your copy of the code; Render deploys from it | Keep the repository **private** if you like; the code is yours after the transfer. |
| 4 | **Render** (Starter plan, about $7/month) | Hosts the website + server | Free plan sleeps; don't use it for a live business. |
| 5 | **Domain name** (Namecheap, GoDaddy, Cloudflare) | Your brand, e.g. `www.yourbrand.com` | Also avoids wallet warnings tied to the shared `onrender.com` address. |
| 6 | **Alchemy** or **Infura** | Private Polygon RPC URL for the server and for deploying | Free tier is enough to start. Create one app for Polygon mainnet and one for Polygon Amoy. |
| 7 | **Etherscan API key** (Etherscan API v2, also covers Polygonscan) | Publishing verified contract source | Free. Verified contracts build buyer trust. |
| 8 | **Pinata** | Stores prompt metadata on IPFS | Free plan to start. Create a JWT with pinning permission. |
| 9 | **Anthropic API key** (console.anthropic.com) | "Draft with AI" button | Optional. Leave blank to hide the button. Set a monthly spend limit. |
| 10 | **Chartered Accountant / lawyer in India** | Tax, registration, terms of service | See Part 6. |

**Nothing should remain in the previous owner's name.** Do not reuse any of their keys.

---

## Part 2: One-time setup on your computer

Requirements: Node.js 18+, Python 3.9+, Git.

```bash
git clone <your-repo-url> prompt-nft && cd prompt-nft
npm install
python3 -m venv server/.venv && server/.venv/bin/pip install -r server/requirements.txt
cp .env.example .env
```

Generate **your own master key** (it encrypts every prompt sold on the platform):

```bash
server/.venv/bin/python -c "import sys; sys.path.insert(0,'server'); import crypto_box; print(crypto_box.new_master_key())"
```

Put it in `.env` as `MASTER_KEY=...` and **back it up** in two safe offline places (for example a
password manager and a printed copy in a locked place). **If this key is lost, no buyer can ever
unlock a prompt they bought.** If it leaks, every prompt can be read: rotate hosting secrets and
treat it as an incident.

Run the tests:

```bash
npx hardhat test                               # 11 contract tests
(cd server && .venv/bin/python -m pytest -q)   # server tests
```

---

## Part 3: Rehearse on Polygon Amoy (test network, free)

1. In MetaMask, create a **separate test account**. Get free Amoy POL from a faucet
   (search "Polygon Amoy faucet").
2. In `.env` set:
   ```
   AMOY_RPC_URL=<your Alchemy/Infura Amoy URL>
   DEPLOYER_PRIVATE_KEY=<the TEST account's private key>
   ETHERSCAN_API_KEY=<your key>
   FEE_RECIPIENT=<the TEST account address>
   ```
3. Deploy and verify:
   ```bash
   npx hardhat run scripts/deploy.js --network amoy
   npx hardhat verify --network amoy <PromptNFT address>
   npx hardhat verify --network amoy <Marketplace address> <PromptNFT address> 250 <FEE_RECIPIENT>
   ```
   Addresses are saved in `deployments/amoy.json`.
4. Run the site locally against Amoy:
   ```bash
   NETWORK=amoy RPC_URL=<Amoy URL> (cd server && .venv/bin/uvicorn app:app --port 8000)
   ```
   Open http://127.0.0.1:8000, connect MetaMask (it offers to add Polygon Amoy), then **mint, list,
   buy from a second test account, unlock, and withdraw**. Confirm the seller is locked out after the sale.

Only continue when every step works.

---

## Part 4: Go live on Polygon mainnet (real money)

Complete `docs/LAUNCH_CHECKLIST.md` first.

1. Fund your **deploy/owner wallet** with a little POL (deploying costs well under 1 POL; keep a few
   POL for later admin transactions).
2. In `.env` on **your own computer only**:
   ```
   POLYGON_RPC_URL=<your Alchemy/Infura Polygon mainnet URL>
   DEPLOYER_PRIVATE_KEY=<your deploy/owner wallet key>   # never share, never commit
   FEE_RECIPIENT=<the wallet that should receive platform fees>
   PLATFORM_FEE_BPS=250        # 250 = 2.5%. The contract caps it at 5%.
   CONFIRM_MAINNET=yes         # safety lock; the script refuses without it
   ```
3. Deploy and verify:
   ```bash
   npx hardhat run scripts/deploy.js --network polygon
   npx hardhat verify --network polygon <PromptNFT address>
   npx hardhat verify --network polygon <Marketplace address> <PromptNFT address> <fee bps> <FEE_RECIPIENT>
   ```
4. Commit `deployments/polygon.json` (addresses + ABIs only, no secrets) and push to **your** GitHub.
5. **Remove `DEPLOYER_PRIVATE_KEY` from `.env`** after deploying, and set `CONFIRM_MAINNET=` back to blank.

### Hosting on Render
1. Render → New → Blueprint → choose your repo → select **`render.polygon.yaml`**.
2. Fill in the secret values: `MASTER_KEY`, `RPC_URL` (your Polygon URL), `PINATA_JWT`,
   `PUBLIC_BASE_URL` (your domain, e.g. `https://www.yourbrand.com`), `ANTHROPIC_API_KEY` (optional),
   `OPERATOR_NAME`, `OPERATOR_TERMS_URL`, `OPERATOR_CONTACT`.
3. Settings → Custom Domains → add your domain, then create the DNS records Render shows at your registrar.
4. Open `https://<your-domain>/api/config` and check: `"network": "polygon"`, `"chainId": 137`, `"testnet": false`.
5. Do one small real end-to-end test yourself (mint, list at a tiny price, buy from a second wallet, unlock).

---

## Part 5: Running the business

| Task | How |
|---|---|
| **Collect platform fees** | Fees accumulate in the marketplace contract for `FEE_RECIPIENT`. Connect that wallet on the site → **My prompts** → **Withdraw**. |
| **Change the fee** | Owner wallet calls `setFee(newBps, recipient)` on the Marketplace via Polygonscan → Contract → Write (connect the owner wallet). Max 500 bps (5%). |
| **Creator royalties** | Set per prompt at mint (max 10%). Paid automatically on resales into each creator's withdrawable balance. |
| **Back up** | `MASTER_KEY` (offline), wallet recovery phrase (offline), `deployments/polygon.json` (in git). |
| **Monitor** | Render dashboard (uptime, logs); Polygonscan for contract activity; Anthropic console for AI spend. |
| **AI assist abuse** | Limits are `ASSIST_PER_HOUR` / `ASSIST_PER_DAY` in Render settings. Set a spend cap in the Anthropic console. |
| **Updating the website** | Edit `web/` files, push to GitHub; Render redeploys automatically. Contracts cannot be changed once deployed. |

### Known limits (tell users in your terms)
- The server holds the master key, so buyers trust the operator to keep it safe.
- The duplicate check blocks exact copies of a prompt, not reworded ones.
- Contracts are not upgradeable. A redesign means deploying new contracts.

---

## Part 6: Legal, tax and compliance (India), to confirm with professionals

This is a checklist of topics to raise with a Chartered Accountant and a lawyer, **not legal advice**:
- **Business structure:** sole proprietorship vs. company; bank account for the business.
- **Virtual Digital Asset (VDA) rules:** whether the platform must register with **FIU-IND** under the
  PMLA as a VDA service provider, and the KYC/AML duties that follow.
- **Income tax:** 30% tax on VDA income and 1% TDS on transfers (Section 194S); how platform fees are treated.
- **GST** on platform/marketplace fees.
- **Terms of service and privacy policy** (drafts in `docs/legal/`): have them reviewed before launch.
- **Consumer and content rules:** who is responsible for prompts that infringe someone else's rights,
  and a takedown/contact process.

---

## Part 7: Security basics

- Never paste private keys, the master key or API keys into chat tools, email or documents.
- Use a hardware wallet for the owner/fee wallet once real money flows.
- Turn on 2-factor authentication for GitHub, Render, Alchemy, Pinata, Anthropic, the exchange and the domain registrar.
- Before significant volume, get an independent **smart-contract security review** (audit).

---

## Part 8: Keeping wallets from flagging the site

Wallets (MetaMask, Phantom, Rabby, Trust) use security scanners (for example Blockaid and Blowfish)
that warn about sites that look like scams. The app is built to avoid the usual triggers:

- **No "approve all" requests.** Listing approves only the single NFT being listed (`approve`), never
  `setApprovalForAll`, which wallet-drainer sites use.
- **Standard sign-in message.** Unlocking uses Sign-In with Ethereum (EIP-4361), bound to your domain, with
  a 5-minute expiry. Wallets recognise it and confirm the domain matches the site.
- **Wallet connects only when the visitor clicks "Connect wallet"**; nothing pops up on page load.

What **you** must do:
1. **Use your own domain**, not `*.onrender.com`. Shared hosting domains are often flagged because
   phishing sites use them too. Keep HTTPS on (Render does this automatically).
2. **Verify both contracts** on Polygonscan (Part 4). Unverified contracts look suspicious to scanners.
3. **Request a name tag** for your contracts on Polygonscan (contract page → "Update name tag").
4. **If a wallet still warns**, file a false-positive report quickly:
   - MetaMask: open an issue at `github.com/MetaMask/eth-phishing-detect` (include your domain and contract addresses)
   - Blockaid (used by MetaMask and others): use the false-positive report on Blockaid's website
   - Phantom: report via Phantom's support / in-app "report false positive"
5. **Don't** use URL shorteners, pop-ups that ask for signatures on page load, airdrop/"free mint"
   wording, or look-alike names of other brands. These raise scanner scores.
6. **Keep the site stable**: a domain that has been live for a while with a clean history is trusted more.

### Safari and phones
Safari has no MetaMask extension, and phone browsers have no wallet. When no wallet is found, the
"Connect wallet" button opens a help dialog: on phones it offers **Open in MetaMask / Coinbase Wallet /
Trust Wallet** (the site reopens in that app's browser); on desktop Safari it suggests Chrome, Brave,
Edge or Firefox with MetaMask. Browsing works everywhere without a wallet.

**Optional upgrade:** add WalletConnect (Reown AppKit) so visitors can scan a QR code with any wallet
app from any browser, including desktop Safari. It needs a free project ID from Reown Cloud
(cloud.reown.com) in your name.

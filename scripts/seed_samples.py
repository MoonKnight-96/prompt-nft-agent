"""Mint and list a few sample prompts on Sepolia (test network, no real money).

Encryption and IPFS pinning go through the LIVE server, so the live site can
unlock them with its own master key. Minting uses the deployer test wallet.

Run:  server/.venv/bin/python scripts/seed_samples.py
"""
import json
from pathlib import Path

import requests
from dotenv import dotenv_values
from eth_account import Account
from web3 import Web3

ROOT = Path(__file__).resolve().parent.parent
API = "https://prompt-nft-market.onrender.com"
e = dotenv_values(ROOT / ".env")
dep = json.loads((ROOT / "deployments" / "sepolia.json").read_text())
w3 = Web3(Web3.HTTPProvider(e["SEPOLIA_RPC_URL"]))
nft = w3.eth.contract(address=dep["promptNFT"], abi=dep["abi"]["promptNFT"])
mkt = w3.eth.contract(address=dep["marketplace"], abi=dep["abi"]["marketplace"])
me = Account.from_key(e["DEPLOYER_PRIVATE_KEY"])

SAMPLES = [
    {
        "title": "Month-End Variance Commentary Writer",
        "description": "Turn a budget-vs-actual table into board-ready variance commentary: the drivers behind each material line, whether it is timing or permanent, and what to watch next month. Built for FP&A analysts and controllers at close.",
        "model": "Claude", "category": "Finance", "price": "0.002", "royalty": 500,
        "sample_output": "Marketing expense: $412K vs $350K budget (+$62K, +18%, unfavorable)\nDriver: Q3 trade-show spend pulled forward from October (timing, ~$45K) plus a new paid-search test ($17K, permanent if continued).\nWatch: October should come in ~$45K under budget; decide on the search test by mid-month.",
        "prompt": "You are a senior FP&A analyst writing month-end variance commentary for the CFO.\n\nInput: a budget-vs-actual table (line item, budget, actual) and optional notes from department owners.\n\nSteps:\n1. Compute $ and % variance for every line. Mark a line MATERIAL if |variance| >= $25,000 AND >= 10% (or use the thresholds I give you).\n2. For each MATERIAL line only, write 2-3 sentences: the amount and direction (favorable/unfavorable), the most likely drivers based on the notes, and whether it is TIMING (reverses next period) or PERMANENT.\n3. Never invent a driver. If the notes don't explain a variance, write 'Driver not yet confirmed - ask <owner>' and list the exact question to ask.\n4. End with 'Watch next month': up to 3 bullets.\n\nFormat: plain text, one block per line item, numbers formatted like $412K and +18%. Keep the whole memo under 300 words.",
    },
    {
        "title": "Python Code Reviewer: Bugs First",
        "description": "Paste a Python function or module and get a focused review: real bugs and edge cases first, then security issues, then a short list of worthwhile simplifications, each with a fixed snippet. No style nitpicks.",
        "model": "Claude", "category": "Coding", "price": "0.0015", "royalty": 500,
        "sample_output": "BUG (high): `average(xs)` divides by len(xs) - crashes with ZeroDivisionError on an empty list.\nFix:\n    if not xs: return 0.0\n\nEDGE CASE: `parse_date` assumes MM/DD/YYYY; '2026-11-16' raises ValueError.\nSIMPLIFY: the manual loop in `totals` is `sum(r.amount for r in rows)`.",
        "prompt": "Act as a strict senior Python reviewer. Review the code I paste.\n\nReport in this order and skip any empty section:\n1. BUGS - code that gives a wrong result or crashes for some input. For each: severity (high/med/low), the exact input that triggers it, and a minimal fixed snippet.\n2. EDGE CASES - empty inputs, None, unicode, time zones, large numbers, concurrency.\n3. SECURITY - injection, unsafe deserialization, secrets in code, path traversal.\n4. SIMPLIFY - at most 3 changes that clearly reduce code or complexity.\n\nRules: no style or naming comments; don't rewrite the whole file; if you are not sure something is a bug, say what you would test to confirm it. Finish with one line: 'Ship it' or 'Fix the high-severity items first'.",
    },
    {
        "title": "Cold Email That Gets Replies",
        "description": "Give it who you're writing to and what you want, and get three short cold-email versions (direct, curious, value-first) with subject lines, each under 120 words and built around one specific, verifiable detail about the reader.",
        "model": "Any model", "category": "Writing", "price": "0.001", "royalty": 500,
        "sample_output": "Subject: Your Q3 close went from 9 to 6 days?\n\nHi Priya - I saw your post about cutting close time at Acme. I built a small reconciliation agent that did something similar for a payments team (1.5 days saved). Would a 15-minute walkthrough next Tuesday be useful?\n\n- Sam",
        "prompt": "You write cold emails that busy people actually answer.\n\nAsk me (if I haven't given them): who the reader is, one specific thing they did or said recently, what I want from them, and one result I can point to.\n\nThen write 3 versions:\nA) Direct - the ask in the first two sentences.\nB) Curious - open with a short question about their recent work.\nC) Value-first - lead with something useful I can give them.\n\nRules for every version: under 120 words; one subject line under 7 words; mention the specific detail about the reader in the first line; exactly one clear ask with a small time commitment; no flattery, no 'I hope this finds you well', no buzzwords. After the three versions, say in one line which you'd send and why.",
    },
    {
        "title": "10-K Risk Factor Summarizer",
        "description": "Paste the Risk Factors section of a 10-K and get the 7 risks that actually matter, ranked by likely impact, with what changed from last year's filing and a one-line 'so what' for an investor.",
        "model": "Claude", "category": "Investing", "price": "0.0025", "royalty": 750,
        "sample_output": "1. Customer concentration (HIGH) - top 2 customers = 41% of revenue, up from 33%. So what: losing one would cut revenue by a fifth.\n2. Debt refinancing (MED-HIGH) - $1.2B matures in 2027; new language on rising rates. So what: watch interest expense guidance.\n...\nNew this year: AI regulation risk (EU AI Act) added as a standalone factor.",
        "prompt": "You are an equity research analyst. I will paste the Risk Factors section (Item 1A) of a 10-K, and optionally last year's.\n\n1. Ignore boilerplate risks every company lists (general economy, pandemics, 'we may not succeed') unless the company gives specific numbers or events.\n2. Pick the 7 risks most likely to move the stock. For each: a short name, impact rating (HIGH / MED-HIGH / MED), the specific evidence from the text (quote numbers exactly), and a one-line 'So what' for an investor.\n3. If I gave last year's section, add 'New this year' and 'Removed this year' lists.\n4. Never add facts that aren't in the text. If a number isn't given, say 'not quantified'.\n\nKeep it under 350 words, ranked from most to least important.",
    },
]


def send(fn):
    tx = fn.build_transaction({"from": me.address, "nonce": w3.eth.get_transaction_count(me.address), "chainId": 11155111})
    tx["maxPriorityFeePerGas"] = w3.to_wei(1.5, "gwei")
    tx["maxFeePerGas"] = w3.eth.fee_history(1, "latest", [50])["baseFeePerGas"][-1] * 2 + tx["maxPriorityFeePerGas"]
    tx.pop("gasPrice", None)
    rcpt = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(me.sign_transaction(tx).rawTransaction), timeout=300)
    assert rcpt.status == 1
    return rcpt


print(f"wallet {me.address}  balance {w3.from_wei(w3.eth.get_balance(me.address), 'ether'):.4f} SepoliaETH")
if not nft.functions.isApprovedForAll(me.address, dep["marketplace"]).call():
    send(nft.functions.setApprovalForAll(dep["marketplace"], True))
for s in SAMPLES:
    body = {k: s[k] for k in ("title", "description", "model", "category", "sample_output", "prompt")}
    r = requests.post(f"{API}/api/prepare", json={**body, "creator": me.address}, timeout=90)
    if r.status_code != 200:
        print("SKIP", s["title"], r.status_code, r.text[:200]); continue
    prep = r.json()
    rcpt = send(nft.functions.mint(prep["tokenURI"], prep["promptHash"], s["royalty"]))
    tid = nft.events.PromptMinted().process_receipt(rcpt)[0]["args"]["tokenId"]
    send(mkt.functions.list(tid, w3.to_wei(s["price"], "ether")))
    print(f"#{tid} {s['title']}  listed at {s['price']} SepoliaETH")
print("done")

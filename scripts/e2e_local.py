"""End-to-end check against a local Hardhat node + running server.

Flow: Alice prepares + mints a prompt and lists it, Bob buys it, Bob unlocks
the prompt, Alice can no longer unlock it, Alice withdraws her proceeds.
Uses Hardhat's well-known local test accounts (worthless, local only).

Run: server/.venv/bin/python scripts/e2e_local.py
"""
import json
import sys
from pathlib import Path

import requests
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

ROOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:8000"
dep = json.loads((ROOT / "deployments" / "localhost.json").read_text())
w3 = Web3(Web3.HTTPProvider("http://127.0.0.1:8545"))
nft = w3.eth.contract(address=dep["promptNFT"], abi=dep["abi"]["promptNFT"])
mkt = w3.eth.contract(address=dep["marketplace"], abi=dep["abi"]["marketplace"])
alice, bob = w3.eth.accounts[1], w3.eth.accounts[2]  # unlocked node accounts


def send(fn, sender, value=0):
    tx = fn.transact({"from": sender, "value": value})
    rcpt = w3.eth.wait_for_transaction_receipt(tx)
    assert rcpt.status == 1
    return rcpt


def unlock(addr, token_id):
    # Node accounts are unlocked; sign via eth_sign-compatible personal_sign
    msg = requests.get(f"{API}/api/nonce", params={"token_id": token_id, "address": addr}).json()["message"]
    sig = w3.eth.sign(addr, text=msg).hex()
    return requests.post(f"{API}/api/unlock", json={"token_id": token_id, "address": addr, "signature": sig})


prompt = "Act as a credit analyst. Given a company's last 3 years of financials, rate its credit risk 1-10 and explain the 3 biggest drivers. Run " + str(__import__("time").time())
r = requests.post(f"{API}/api/prepare", json={
    "title": "Credit risk rater", "description": "Rates credit risk from financial statements.",
    "model": "Claude", "category": "Finance", "sample_output": "Rating: 4/10. Drivers: leverage...",
    "prompt": prompt, "creator": alice,
})
r.raise_for_status()
prep = r.json()
print("prepared", prep["tokenURI"])

rcpt = send(nft.functions.mint(prep["tokenURI"], prep["promptHash"], 500), alice)
token_id = nft.events.PromptMinted().process_receipt(rcpt)[0]["args"]["tokenId"]
print("minted token", token_id)

dup = requests.post(f"{API}/api/prepare", json={"title": "Copy", "description": "Same prompt again.",
                    "model": "Claude", "category": "Finance", "sample_output": "Copy", "prompt": prompt + "  ", "creator": bob})
assert dup.status_code == 409, dup.text
print("duplicate rejected:", dup.json()["detail"])

assert unlock(alice, token_id).json()["prompt"] == prompt
print("creator can unlock before sale")

send(nft.functions.setApprovalForAll(dep["marketplace"], True), alice)
price = w3.to_wei(0.01, "ether")
send(mkt.functions.list(token_id, price), alice)
send(mkt.functions.buy(token_id), bob, value=price)
assert nft.functions.ownerOf(token_id).call() == bob
print("bob bought it")

r_bob = unlock(bob, token_id)
assert r_bob.status_code == 200 and r_bob.json()["prompt"] == prompt
print("bob unlocked:", r_bob.json()["prompt"][:50] + "...")
assert unlock(alice, token_id).status_code == 403
print("alice is locked out after selling")

owed = mkt.functions.proceeds(alice).call()
send(mkt.functions.withdraw(), alice)
print(f"alice withdrew {w3.from_wei(owed, 'ether')} ETH (price minus 2.5% fee)")

meta = requests.get(prep["tokenURI"]).json()
assert prompt[:30] not in json.dumps(meta)
print("public metadata does not contain the prompt")
print("E2E OK")

"""Live end-to-end check on Sepolia (test network, no real money).

Seller = the deployer test wallet from .env. Buyer = a throwaway test wallet
created on first run and stored in .env as E2E_BUYER_KEY, funded with a tiny
amount of Sepolia ETH from the seller.

Run (server must be running with NETWORK=sepolia):
    server/.venv/bin/python scripts/e2e_sepolia.py
"""
import json
import time
from pathlib import Path

import requests
from dotenv import dotenv_values, set_key
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
API = "http://127.0.0.1:8000"
e = dotenv_values(ENV)
dep = json.loads((ROOT / "deployments" / "sepolia.json").read_text())
w3 = Web3(Web3.HTTPProvider(e["SEPOLIA_RPC_URL"]))
nft = w3.eth.contract(address=dep["promptNFT"], abi=dep["abi"]["promptNFT"])
mkt = w3.eth.contract(address=dep["marketplace"], abi=dep["abi"]["marketplace"])

seller = Account.from_key(e["DEPLOYER_PRIVATE_KEY"])
if not e.get("E2E_BUYER_KEY"):
    set_key(str(ENV), "E2E_BUYER_KEY", "0x" + Account.create().key.hex().removeprefix("0x"), quote_mode="never")
    e = dotenv_values(ENV)
buyer = Account.from_key(e["E2E_BUYER_KEY"])
eth = lambda wei: f"{w3.from_wei(wei, 'ether'):.5f}"


def send(acct, fn=None, to=None, value=0):
    tx = (fn.build_transaction({"from": acct.address, "value": value}) if fn
          else {"from": acct.address, "to": to, "value": value})  # gas estimated: new-account cost varies by fork
    tx["nonce"] = w3.eth.get_transaction_count(acct.address)
    tx.setdefault("chainId", 11155111)
    fees = w3.eth.fee_history(1, "latest", [50])
    base = fees["baseFeePerGas"][-1]
    tx["maxPriorityFeePerGas"] = w3.to_wei(1.5, "gwei")
    tx["maxFeePerGas"] = base * 2 + tx["maxPriorityFeePerGas"]
    tx.pop("gasPrice", None)
    if "gas" not in tx:
        tx["gas"] = int(w3.eth.estimate_gas(tx) * 1.2)
    h = w3.eth.send_raw_transaction(acct.sign_transaction(tx).rawTransaction)
    rcpt = w3.eth.wait_for_transaction_receipt(h, timeout=300)
    assert rcpt.status == 1, f"tx failed {h.hex()}"
    return rcpt


def unlock(acct, token_id):
    msg = requests.get(f"{API}/api/nonce", params={"token_id": token_id, "address": acct.address}).json()["message"]
    sig = Account.sign_message(encode_defunct(text=msg), acct.key).signature.hex()
    return requests.post(f"{API}/api/unlock", json={"token_id": token_id, "address": acct.address, "signature": sig})


print(f"seller {seller.address}  balance {eth(w3.eth.get_balance(seller.address))}")
print(f"buyer  {buyer.address}  balance {eth(w3.eth.get_balance(buyer.address))}")

price = w3.to_wei(0.001, "ether")
if w3.eth.get_balance(buyer.address) < price + w3.to_wei(0.001, "ether"):
    send(seller, to=buyer.address, value=w3.to_wei(0.003, "ether"))
    print("funded buyer with 0.003 SepoliaETH")

prompt = ("You are a month-end close reviewer. Given a trial balance and last month's, list the 5 accounts "
          f"with the largest unexplained swings and the question to ask the account owner for each. (live test {int(time.time())})")
r = requests.post(f"{API}/api/prepare", json={
    "title": "Month-end flux reviewer", "description": "Finds unexplained balance swings and drafts owner questions.",
    "model": "Claude", "category": "Finance", "sample_output": "1. Accrued expenses +42%: what drove the new accrual?...",
    "prompt": prompt, "creator": seller.address,
})
r.raise_for_status()
prep = r.json()
print("metadata on IPFS:", prep["tokenURI"])

rcpt = send(seller, nft.functions.mint(prep["tokenURI"], prep["promptHash"], 500))
token_id = nft.events.PromptMinted().process_receipt(rcpt)[0]["args"]["tokenId"]
print(f"minted token #{token_id}  tx {rcpt.transactionHash.hex()}")

if not nft.functions.isApprovedForAll(seller.address, dep["marketplace"]).call():
    send(seller, nft.functions.setApprovalForAll(dep["marketplace"], True))
send(seller, mkt.functions.list(token_id, price))
print("listed for 0.001 SepoliaETH")

assert unlock(buyer, token_id).status_code == 403
print("buyer cannot unlock before buying")

rcpt = send(buyer, mkt.functions.buy(token_id), value=price)
assert nft.functions.ownerOf(token_id).call() == buyer.address
print(f"buyer bought #{token_id}  tx {rcpt.transactionHash.hex()}")

r = unlock(buyer, token_id)
assert r.status_code == 200 and r.json()["prompt"] == " ".join(prompt.split()), r.text
print("buyer unlocked the prompt")
assert unlock(seller, token_id).status_code == 403
print("seller is locked out after the sale")

owed = mkt.functions.proceeds(seller.address).call()
send(seller, mkt.functions.withdraw())
print(f"seller withdrew {eth(owed)} SepoliaETH")
print("LIVE E2E OK")

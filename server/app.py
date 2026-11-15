"""Prompt NFT server: encrypts prompts before minting, stores metadata, and
unlocks a prompt only for the wallet that currently owns the NFT.

Run:  uvicorn app:app --reload   (from the server/ folder)
"""
import json
import os
import secrets
import time
from pathlib import Path
from typing import Dict, Optional, Tuple

from dotenv import load_dotenv
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from web3 import Web3

import crypto_box
from assist import Assistant, AssistError
from storage import Storage

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

NONCE_TTL = 300  # seconds


class Settings:
    def __init__(self):
        self.master_key = crypto_box.load_master_key(os.environ["MASTER_KEY"])
        self.rpc_url = os.getenv("RPC_URL", "http://127.0.0.1:8545")
        # Read-only RPC given to browsers so people can browse without a wallet.
        # Use a public endpoint here, never one containing a private API key.
        self.public_rpc_url = os.getenv("PUBLIC_RPC_URL", self.rpc_url)
        self.network = os.getenv("NETWORK", "localhost")
        self.public_base_url = os.getenv("PUBLIC_BASE_URL", "http://127.0.0.1:8000")
        self.pinata_jwt = os.getenv("PINATA_JWT", "")
        self.storage_dir = Path(os.getenv("STORAGE_DIR", ROOT / "server" / "storage"))
        self.deployment_file = Path(os.getenv("DEPLOYMENT_FILE", ROOT / "deployments" / f"{self.network}.json"))


class Chain:
    """Thin wrapper so tests can swap in a fake."""

    def __init__(self, rpc_url: str, deployment: dict):
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.nft = self.w3.eth.contract(address=deployment["promptNFT"], abi=deployment["abi"]["promptNFT"])

    def owner_of(self, token_id: int) -> str:
        return self.nft.functions.ownerOf(token_id).call()

    def token_uri(self, token_id: int) -> str:
        return self.nft.functions.tokenURI(token_id).call()

    def token_by_hash(self, prompt_hash: str) -> int:
        return self.nft.functions.tokenByPromptHash(prompt_hash).call()


class PrepareRequest(BaseModel):
    title: str = Field(min_length=3, max_length=80)
    description: str = Field(min_length=10, max_length=600)
    model: str = Field(min_length=2, max_length=60)
    category: str = Field(min_length=2, max_length=40)
    sample_output: str = Field(min_length=1, max_length=2000)
    prompt: str = Field(min_length=20, max_length=8000)
    creator: str


class AssistRequest(BaseModel):
    idea: str = Field(min_length=10, max_length=1000)
    category: str = Field(default="", max_length=40)
    model: str = Field(default="", max_length=60)


class UnlockRequest(BaseModel):
    token_id: int = Field(ge=1)
    address: str
    signature: str


def unlock_message(token_id: int, address: str, nonce: str, issued: int) -> str:
    return (
        "Prompt NFT: unlock request\n"
        f"Token: #{token_id}\n"
        f"Wallet: {address}\n"
        f"Nonce: {nonce}\n"
        f"Issued: {issued}\n"
        "Signing this proves you own the NFT. It costs no gas."
    )


def create_app(settings: Optional[Settings] = None, chain=None, storage: Optional[Storage] = None,
               assistant: Optional[Assistant] = None) -> FastAPI:
    settings = settings or Settings()
    assistant = assistant or Assistant()
    deployment = None
    if settings.deployment_file.exists():
        deployment = json.loads(settings.deployment_file.read_text())
    if chain is None and deployment:
        chain = Chain(settings.rpc_url, deployment)
    storage = storage or Storage(settings.storage_dir, settings.public_base_url, settings.pinata_jwt)
    nonces: Dict[Tuple[int, str], Tuple[str, int]] = {}

    app = FastAPI(title="Prompt NFT")

    def need_chain():
        if chain is None:
            raise HTTPException(503, "Contracts not deployed for this network yet")
        return chain

    @app.get("/api/config")
    def config():
        if not deployment:
            raise HTTPException(503, "Contracts not deployed for this network yet")
        return {
            "network": deployment["network"],
            "chainId": deployment["chainId"],
            "promptNFT": deployment["promptNFT"],
            "marketplace": deployment["marketplace"],
            "abi": deployment["abi"],
            "storage": storage.mode,
            "rpcUrl": settings.public_rpc_url,
            "assist": assistant.enabled,
        }

    @app.post("/api/assist")
    def assist(req: AssistRequest, request: Request):
        # Behind Render's proxy: the last X-Forwarded-For hop is the address the
        # proxy saw (earlier hops can be forged by the visitor). The global daily
        # cap in RateLimiter is the hard backstop either way.
        fwd = request.headers.get("x-forwarded-for", "")
        client_id = fwd.split(",")[-1].strip() or (request.client.host if request.client else "unknown")
        try:
            return assistant.draft(req.idea, req.category, req.model, client_id)
        except AssistError as e:
            raise HTTPException(e.status, e.message)

    @app.post("/api/prepare")
    def prepare(req: PrepareRequest):
        if not Web3.is_address(req.creator):
            raise HTTPException(400, "Invalid creator address")
        phash = crypto_box.prompt_hash(req.prompt)
        existing = need_chain().token_by_hash(phash)
        if existing:
            raise HTTPException(409, f"This prompt is already minted as token #{existing}")
        box = crypto_box.encrypt_prompt(crypto_box.normalize_prompt(req.prompt), settings.master_key, phash)
        metadata = {
            "name": req.title,
            "description": req.description,
            "attributes": [
                {"trait_type": "Model", "value": req.model},
                {"trait_type": "Category", "value": req.category},
                {"trait_type": "Prompt length", "value": len(req.prompt)},
            ],
            "sample_output": req.sample_output,
            "creator": Web3.to_checksum_address(req.creator),
            "prompt_hash": phash,
            "encrypted_prompt": box,
        }
        uri = storage.put_json(metadata, f"prompt-{phash[:10]}")
        return {"tokenURI": uri, "promptHash": phash}

    @app.get("/api/nonce")
    def nonce(token_id: int, address: str):
        if not Web3.is_address(address):
            raise HTTPException(400, "Invalid address")
        addr = Web3.to_checksum_address(address)
        n, issued = secrets.token_hex(16), int(time.time())
        nonces[(token_id, addr)] = (n, issued)
        return {"message": unlock_message(token_id, addr, n, issued)}

    @app.post("/api/unlock")
    def unlock(req: UnlockRequest):
        if not Web3.is_address(req.address):
            raise HTTPException(400, "Invalid address")
        addr = Web3.to_checksum_address(req.address)
        entry = nonces.pop((req.token_id, addr), None)  # single use
        if not entry or time.time() - entry[1] > NONCE_TTL:
            raise HTTPException(401, "Unlock request expired. Try again.")
        msg = unlock_message(req.token_id, addr, *entry)
        try:
            signer = Account.recover_message(encode_defunct(text=msg), signature=req.signature)
        except Exception:
            raise HTTPException(401, "Bad signature")
        if signer != addr:
            raise HTTPException(401, "Signature does not match wallet")
        c = need_chain()
        try:
            owner = c.owner_of(req.token_id)
        except Exception:
            raise HTTPException(404, "Token not found")
        if Web3.to_checksum_address(owner) != addr:
            raise HTTPException(403, "Only the current owner can unlock this prompt")
        try:
            meta = storage.fetch(c.token_uri(req.token_id))
            prompt = crypto_box.decrypt_prompt(meta["encrypted_prompt"], settings.master_key, meta["prompt_hash"])
        except Exception:
            raise HTTPException(500, "Could not decrypt this prompt")
        return {"token_id": req.token_id, "prompt": prompt}

    @app.get("/files/{file_id}")
    def files(file_id: str):
        try:
            return JSONResponse(storage.get_local(file_id))
        except (FileNotFoundError, OSError):
            raise HTTPException(404, "Not found")

    web_dir = ROOT / "web"
    if web_dir.exists():
        app.mount("/static", StaticFiles(directory=web_dir), name="static")

        @app.get("/")
        def index():
            return FileResponse(web_dir / "index.html")

    return app


if os.getenv("MASTER_KEY"):
    app = create_app()

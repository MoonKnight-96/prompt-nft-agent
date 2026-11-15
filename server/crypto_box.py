"""Envelope encryption for prompts.

Each prompt gets its own random 256-bit data key (AES-256-GCM). The data key is
then wrapped (encrypted) with the server's master key. Only the wrapped key and
ciphertext are published in the NFT metadata, so nobody can read the prompt
without the server, and the server only decrypts for the verified owner.
"""
import base64
import os
import re

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from eth_utils import keccak

VERSION = 1


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode()


def b64d(s: str) -> bytes:
    return base64.b64decode(s)


def normalize_prompt(text: str) -> str:
    """Collapse whitespace so trivial spacing changes count as the same prompt."""
    return re.sub(r"\s+", " ", text.strip())


def prompt_hash(text: str) -> str:
    return "0x" + keccak(text=normalize_prompt(text)).hex()


def load_master_key(value: str) -> bytes:
    key = b64d(value)
    if len(key) != 32:
        raise ValueError("MASTER_KEY must be 32 bytes, base64-encoded")
    return key


def new_master_key() -> str:
    return b64e(AESGCM.generate_key(bit_length=256))


def encrypt_prompt(prompt: str, master_key: bytes, token_binding: str) -> dict:
    """token_binding (the prompt hash) is used as associated data so a
    ciphertext can't be swapped into another token's metadata."""
    data_key = AESGCM.generate_key(bit_length=256)
    iv = os.urandom(12)
    ct = AESGCM(data_key).encrypt(iv, prompt.encode(), token_binding.encode())
    wrap_iv = os.urandom(12)
    wrapped = AESGCM(master_key).encrypt(wrap_iv, data_key, token_binding.encode())
    return {
        "v": VERSION,
        "alg": "AES-256-GCM+envelope",
        "iv": b64e(iv),
        "ct": b64e(ct),
        "wrap_iv": b64e(wrap_iv),
        "wrapped_key": b64e(wrapped),
    }


def decrypt_prompt(box: dict, master_key: bytes, token_binding: str) -> str:
    if box.get("v") != VERSION:
        raise ValueError("unsupported encryption version")
    data_key = AESGCM(master_key).decrypt(b64d(box["wrap_iv"]), b64d(box["wrapped_key"]), token_binding.encode())
    return AESGCM(data_key).decrypt(b64d(box["iv"]), b64d(box["ct"]), token_binding.encode()).decode()

import json

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi.testclient import TestClient

import crypto_box
from app import Settings, create_app
from storage import Storage


class FakeChain:
    def __init__(self):
        self.owners, self.uris, self.hashes = {}, {}, {}

    def mint(self, token_id, owner, uri, phash):
        self.owners[token_id], self.uris[token_id], self.hashes[phash] = owner, uri, token_id

    def owner_of(self, token_id):
        if token_id not in self.owners:
            raise ValueError("nonexistent")
        return self.owners[token_id]

    def token_uri(self, token_id):
        return self.uris[token_id]

    def token_by_hash(self, phash):
        return self.hashes.get(phash, 0)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("MASTER_KEY", crypto_box.new_master_key())
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path / "store"))
    monkeypatch.setenv("DEPLOYMENT_FILE", str(tmp_path / "none.json"))
    settings = Settings()
    chain = FakeChain()
    store = Storage(settings.storage_dir, settings.public_base_url)
    client = TestClient(create_app(settings, chain, store))
    return client, chain


ALICE, BOB = Account.create(), Account.create()
PROMPT = "You are a senior equity analyst.   Summarize the 10-K risk factors in 5 bullets."
BODY = dict(title="10-K risk summarizer", description="Summarizes 10-K risk factors clearly.",
            model="Claude", category="Finance", sample_output="1. Supply chain...", prompt=PROMPT)


def prepare_and_mint(client, chain, owner=ALICE, token_id=1):
    r = client.post("/api/prepare", json={**BODY, "creator": owner.address})
    assert r.status_code == 200, r.text
    data = r.json()
    chain.mint(token_id, owner.address, data["tokenURI"], data["promptHash"])
    return data


def sign_unlock(client, acct, token_id=1):
    msg = client.get("/api/nonce", params={"token_id": token_id, "address": acct.address}).json()["message"]
    sig = Account.sign_message(encode_defunct(text=msg), acct.key).signature.hex()
    return client.post("/api/unlock", json={"token_id": token_id, "address": acct.address, "signature": sig})


def test_metadata_is_public_but_prompt_is_encrypted(env):
    client, chain = env
    data = prepare_and_mint(client, chain)
    meta = client.get(data["tokenURI"].replace("http://127.0.0.1:8000", "")).json()
    assert meta["name"] == "10-K risk summarizer"
    assert "Summarize the 10-K" not in json.dumps(meta)
    assert data["promptHash"] == crypto_box.prompt_hash(PROMPT)


def test_owner_can_unlock(env):
    client, chain = env
    prepare_and_mint(client, chain)
    r = sign_unlock(client, ALICE)
    assert r.status_code == 200
    assert r.json()["prompt"] == crypto_box.normalize_prompt(PROMPT)


def test_non_owner_cannot_unlock_and_ownership_follows_transfer(env):
    client, chain = env
    prepare_and_mint(client, chain)
    assert sign_unlock(client, BOB).status_code == 403
    chain.owners[1] = BOB.address  # NFT sold to Bob
    assert sign_unlock(client, BOB).status_code == 200
    assert sign_unlock(client, ALICE).status_code == 403


def test_nonce_is_single_use_and_signature_must_match(env):
    client, chain = env
    prepare_and_mint(client, chain)
    msg = client.get("/api/nonce", params={"token_id": 1, "address": ALICE.address}).json()["message"]
    bob_sig = Account.sign_message(encode_defunct(text=msg), BOB.key).signature.hex()
    assert client.post("/api/unlock", json={"token_id": 1, "address": ALICE.address, "signature": bob_sig}).status_code == 401
    # nonce was consumed by the failed attempt, so replaying a valid signature fails too
    good = Account.sign_message(encode_defunct(text=msg), ALICE.key).signature.hex()
    assert client.post("/api/unlock", json={"token_id": 1, "address": ALICE.address, "signature": good}).status_code == 401


def test_duplicate_prompt_rejected_even_with_different_spacing(env):
    client, chain = env
    prepare_and_mint(client, chain)
    r = client.post("/api/prepare", json={**BODY, "prompt": PROMPT.replace("   ", " ") + "  ", "creator": BOB.address})
    assert r.status_code == 409


def test_ciphertext_cannot_be_moved_to_another_token():
    key = crypto_box.load_master_key(crypto_box.new_master_key())
    box = crypto_box.encrypt_prompt("secret prompt text", key, "0xaaa")
    with pytest.raises(Exception):
        crypto_box.decrypt_prompt(box, key, "0xbbb")


def test_storage_refuses_non_ipfs_urls(tmp_path):
    s = Storage(tmp_path, "http://127.0.0.1:8000")
    with pytest.raises(ValueError):
        s.fetch("http://169.254.169.254/latest/meta-data")

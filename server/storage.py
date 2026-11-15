"""Metadata storage: Pinata (IPFS) when PINATA_JWT is set, otherwise a local
folder served by this server (for development)."""
import hashlib
import json
from pathlib import Path

import requests

PINATA_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS"
GATEWAY = "https://gateway.pinata.cloud/ipfs/"


class Storage:
    def __init__(self, local_dir: Path, public_base_url: str, pinata_jwt: str = ""):
        self.local_dir = local_dir
        self.local_dir.mkdir(parents=True, exist_ok=True)
        self.public_base_url = public_base_url.rstrip("/")
        self.pinata_jwt = pinata_jwt

    @property
    def mode(self) -> str:
        return "ipfs" if self.pinata_jwt else "local"

    def put_json(self, obj: dict, name: str) -> str:
        if self.pinata_jwt:
            r = requests.post(
                PINATA_URL,
                headers={"Authorization": f"Bearer {self.pinata_jwt}"},
                json={"pinataContent": obj, "pinataMetadata": {"name": name}},
                timeout=30,
            )
            r.raise_for_status()
            return "ipfs://" + r.json()["IpfsHash"]
        body = json.dumps(obj, sort_keys=True).encode()
        file_id = hashlib.sha256(body).hexdigest()
        (self.local_dir / f"{file_id}.json").write_bytes(body)
        return f"{self.public_base_url}/files/{file_id}"

    def get_local(self, file_id: str) -> dict:
        if not all(c in "0123456789abcdef" for c in file_id) or len(file_id) != 64:
            raise FileNotFoundError(file_id)
        return json.loads((self.local_dir / f"{file_id}.json").read_bytes())

    def fetch(self, uri: str) -> dict:
        if uri.startswith(self.public_base_url + "/files/"):
            return self.get_local(uri.rsplit("/", 1)[1])
        # Only IPFS or this server's own files: a token URI is chosen by the
        # minter, so never fetch arbitrary URLs from the server.
        if not uri.startswith("ipfs://"):
            raise ValueError("unsupported token URI")
        cid = uri[len("ipfs://"):]
        if not cid or not all(c.isalnum() for c in cid):
            raise ValueError("bad IPFS CID")
        r = requests.get(GATEWAY + cid, timeout=30)
        r.raise_for_status()
        return r.json()

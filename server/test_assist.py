import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import crypto_box
from app import Settings, create_app
from assist import Assistant, AssistError, RateLimiter
from storage import Storage

DRAFT = {"title": " Pitch deck red-flag finder ", "description": "Finds the 5 biggest investor red flags.",
         "prompt": "You are a VC analyst. Review [PITCH DECK TEXT]...", "sample_output": "1. Unclear TAM..."}


class FakeMessages:
    def __init__(self, stop_reason="end_turn", payload=DRAFT):
        self.calls, self.stop_reason, self.payload = [], stop_reason, payload

    def create(self, **kw):
        self.calls.append(kw)
        content = [SimpleNamespace(type="thinking", thinking=""),
                   SimpleNamespace(type="text", text=json.dumps(self.payload))]
        return SimpleNamespace(stop_reason=self.stop_reason, content=content)


def fake_client(**kw):
    msgs = FakeMessages(**kw)
    return SimpleNamespace(beta=SimpleNamespace(messages=msgs)), msgs


def test_draft_returns_trimmed_fields_and_uses_structured_output():
    client, msgs = fake_client()
    a = Assistant(client=client, limiter=RateLimiter(5, 100))
    out = a.draft("a prompt that reviews pitch decks", "Finance", "Claude", "1.2.3.4")
    assert out["title"] == "Pitch deck red-flag finder"
    call = msgs.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert call["fallbacks"] == "default"
    assert "pitch decks" in call["messages"][0]["content"]


def test_refusal_is_reported_not_parsed():
    client, _ = fake_client(stop_reason="refusal")
    with pytest.raises(AssistError) as e:
        Assistant(client=client).draft("some idea here", "", "", "x")
    assert e.value.status == 422


def test_rate_limits_per_client_and_globally():
    lim = RateLimiter(per_client_per_hour=2, global_per_day=3)
    lim.check("a"); lim.check("a")
    with pytest.raises(AssistError):
        lim.check("a")
    lim.check("b")
    with pytest.raises(AssistError):
        lim.check("c")  # global cap reached


def test_disabled_without_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    a = Assistant()
    assert not a.enabled
    with pytest.raises(AssistError) as e:
        a.draft("some idea here", "", "", "x")
    assert e.value.status == 503


def test_endpoint(tmp_path, monkeypatch):
    monkeypatch.setenv("MASTER_KEY", crypto_box.new_master_key())
    monkeypatch.setenv("DEPLOYMENT_FILE", str(tmp_path / "none.json"))
    s = Settings()
    client, _ = fake_client()
    app = create_app(s, chain=None, storage=Storage(tmp_path, s.public_base_url),
                     assistant=Assistant(client=client, limiter=RateLimiter(1, 10)))
    tc = TestClient(app)
    r = tc.post("/api/assist", json={"idea": "a prompt that reviews pitch decks"})
    assert r.status_code == 200 and r.json()["prompt"].startswith("You are a VC analyst")
    assert tc.post("/api/assist", json={"idea": "another idea for a prompt"}).status_code == 429
    assert tc.post("/api/assist", json={"idea": "short"}).status_code == 422  # validation

"""AI assist: turns a creator's rough idea into a polished prompt listing
(title, description, prompt, sample output) using Claude.

The creator reviews and edits everything before minting; the draft is only a
starting point. The Anthropic API key stays on the server.
"""
import json
import os
import threading
import time
from collections import defaultdict, deque
from typing import Optional

import anthropic

MODEL = "claude-opus-5-5"

SYSTEM = """You help creators sell AI prompts on a prompt marketplace.

Given a creator's rough idea, write a listing:
- title: short and specific (3-8 words).
- description: 1-3 sentences on what the prompt does and who it is for. Do not reveal the prompt itself.
- prompt: the full, ready-to-use prompt. Make it clear and reusable: state the role, the task, the inputs the user should paste in (as [PLACEHOLDERS]), the steps, and the output format. Plain text, no markdown headings.
- sample_output: a realistic, concise example of what the prompt produces for a made-up input, so buyers can judge quality. Keep it under 150 words and clearly fictional.

Write in plain, professional English. The creator will review and edit your draft before minting."""

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "description": {"type": "string"},
        "prompt": {"type": "string"},
        "sample_output": {"type": "string"},
    },
    "required": ["title", "description", "prompt", "sample_output"],
    "additionalProperties": False,
}


class AssistError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class RateLimiter:
    """Small in-memory limiter: per-client hourly cap plus a global daily cap,
    so a public site can't run up the API bill."""

    def __init__(self, per_client_per_hour: int, global_per_day: int):
        self.per_client = per_client_per_hour
        self.global_cap = global_per_day
        self.hits = defaultdict(deque)
        self.day_hits = deque()
        self.lock = threading.Lock()

    def check(self, client_id: str) -> None:
        now = time.time()
        with self.lock:
            q = self.hits[client_id]
            while q and now - q[0] > 3600:
                q.popleft()
            while self.day_hits and now - self.day_hits[0] > 86400:
                self.day_hits.popleft()
            if len(self.day_hits) >= self.global_cap:
                raise AssistError(429, "AI assist has reached today's limit. Try again tomorrow.")
            if len(q) >= self.per_client:
                raise AssistError(429, "You've used AI assist a lot this hour. Try again later.")
            q.append(now)
            self.day_hits.append(now)


class Assistant:
    def __init__(self, client: Optional[anthropic.Anthropic] = None, limiter: Optional[RateLimiter] = None):
        self.client = client
        if self.client is None and os.getenv("ANTHROPIC_API_KEY"):
            self.client = anthropic.Anthropic()
        self.limiter = limiter or RateLimiter(
            int(os.getenv("ASSIST_PER_HOUR", "5")), int(os.getenv("ASSIST_PER_DAY", "100"))
        )

    @property
    def enabled(self) -> bool:
        return self.client is not None

    def draft(self, idea: str, category: str, target_model: str, client_id: str) -> dict:
        if not self.enabled:
            raise AssistError(503, "AI assist isn't configured on this server.")
        self.limiter.check(client_id)

        user = (
            f"Category: {category or 'General'}\n"
            f"Target AI model: {target_model or 'any modern chat model'}\n"
            f"Creator's idea:\n{idea}"
        )
        try:
            response = self.client.beta.messages.create(
                model=MODEL,
                max_tokens=16000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                system=SYSTEM,
                messages=[{"role": "user", "content": user}],
                output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
            )
        except anthropic.RateLimitError:
            raise AssistError(429, "AI assist is busy right now. Try again in a minute.")
        except anthropic.APIStatusError as e:
            raise AssistError(502, f"AI assist failed ({e.status_code}).")
        except anthropic.APIConnectionError:
            raise AssistError(502, "Couldn't reach the AI service.")

        if response.stop_reason == "refusal":
            raise AssistError(422, "The AI declined this idea. Try rephrasing it.")
        if response.stop_reason == "max_tokens":
            raise AssistError(502, "The draft was too long. Try a narrower idea.")
        text = next((b.text for b in response.content if b.type == "text"), None)
        if not text:
            raise AssistError(502, "The AI returned an empty draft.")
        data = json.loads(text)
        return {k: data[k].strip() for k in ("title", "description", "prompt", "sample_output")}

"""
Benefits Q&A agent — AgentCore Runtime entrypoint.

Exposes /invocations and /ping per the AgentCore Runtime HTTP contract.
All inference is routed through the platform inference gateway (M2M OAuth,
OpenAI-compatible /inference/v1/chat/completions) — never direct Bedrock.

Runtime environment variables injected by AgentCore Runtime:
  INFERENCE_GATEWAY_URL   — gateway base URL (https://...amazonaws.com)
  INFERENCE_TARGET_NAME   — gateway target prefix  (e.g. agenticai-inference-nonprod-bedrock)
  INFERENCE_MODEL_ID      — short model alias       (e.g. anthropic.claude-sonnet-5)
  COGNITO_TOKEN_ENDPOINT  — Cognito /oauth2/token URL
  COGNITO_CLIENT_ID       — M2M client ID
  COGNITO_CLIENT_SECRET   — M2M client secret
  COGNITO_SCOPE           — OAuth scope
  GUARDRAIL_IDENTIFIER    — Bedrock Guardrail ID (passed in payload for audit)
  GUARDRAIL_VERSION       — Guardrail version; defaults to "DRAFT"
  PLAN_YEAR               — Benefits plan year; defaults to "2026"
  AWS_REGION              — Injected by the Runtime execution environment

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Iterator

import requests

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")


def _require_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(f"Required environment variable {name!r} is not set")
    return val


def _load_m2m_secret() -> dict:
    """Fetch the inference gateway M2M credentials from Secrets Manager.

    The secret ARN is injected as INFERENCE_M2M_SECRET_ARN. Returns a dict
    with clientId, clientSecret, tokenEndpoint, scope, gatewayUrl keys.
    """
    secret_arn = _require_env("INFERENCE_M2M_SECRET_ARN")
    import boto3
    import json as _json
    client = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    response = client.get_secret_value(SecretId=secret_arn)
    return _json.loads(response["SecretString"])


# ── M2M token cache ────────────────────────────────────────────────────────────

class _TokenCache:
    def __init__(self) -> None:
        self._token: str = ""
        self._expires_at: float = 0.0

    def get(
        self,
        token_endpoint: str,
        client_id: str,
        client_secret: str,
        scope: str,
    ) -> str:
        if time.monotonic() < self._expires_at - 30:
            return self._token
        resp = requests.post(
            token_endpoint,
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
                "scope": scope,
            },
            timeout=10,
        )
        resp.raise_for_status()
        body = resp.json()
        self._token = body["access_token"]
        self._expires_at = time.monotonic() + body.get("expires_in", 3600)
        log.info("M2M token refreshed, expires_in=%s", body.get("expires_in"))
        return self._token


_token_cache = _TokenCache()


# ── Gateway inference client ───────────────────────────────────────────────────

class _GatewayLLMClient:
    """Calls the platform inference gateway OpenAI-compatible endpoint."""

    def __init__(
        self,
        gateway_url: str,
        model_id: str,
        token_endpoint: str,
        client_id: str,
        client_secret: str,
        scope: str,
    ) -> None:
        # Claude models use the Anthropic Messages API path on the gateway
        self._messages_url = gateway_url.rstrip("/") + "/inference/v1/messages"
        self._model = model_id
        self._token_endpoint = token_endpoint
        self._client_id = client_id
        self._client_secret = client_secret
        self._scope = scope

    def _token(self) -> str:
        return _token_cache.get(
            self._token_endpoint,
            self._client_id,
            self._client_secret,
            self._scope,
        )

    def invoke(
        self,
        messages: list[dict[str, str]],
        *,
        guardrail_identifier: str = "",
        guardrail_version: str = "DRAFT",
        stream: bool = False,
    ) -> str:
        # Split system prompt out (Anthropic Messages API has a top-level system field)
        system_prompt = ""
        chat_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_prompt = msg["content"]
            else:
                chat_messages.append({"role": msg["role"], "content": msg["content"]})

        body: dict[str, Any] = {
            "model": self._model,
            "max_tokens": 4096,
            "messages": chat_messages,
        }
        if system_prompt:
            body["system"] = system_prompt

        # Stamp W3C baggage with session.id so the gateway interceptor can
        # correlate guardrail decisions back to this AgentCore runtime session.
        headers: dict[str, str] = {
            "Authorization": f"Bearer {self._token()}",
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
        }
        try:
            from bedrock_agentcore import BedrockAgentCoreContext  # type: ignore[import-not-found]
            sid = BedrockAgentCoreContext.get_session_id()
            if sid:
                headers["baggage"] = f"session.id={sid}"
        except Exception:
            pass

        resp = requests.post(
            self._messages_url,
            headers=headers,
            json=body,
            timeout=120,
        )
        if not resp.ok:
            log.error("Gateway error %s: %s", resp.status_code, resp.text)
            resp.raise_for_status()
        data = resp.json()
        return data["content"][0]["text"]

    def stream_invoke(
        self,
        messages: list[dict[str, str]],
        *,
        guardrail_identifier: str = "",
        guardrail_version: str = "DRAFT",
    ) -> Iterator[str]:
        system_prompt = ""
        chat_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_prompt = msg["content"]
            else:
                chat_messages.append({"role": msg["role"], "content": msg["content"]})

        body: dict[str, Any] = {
            "model": self._model,
            "max_tokens": 4096,
            "messages": chat_messages,
            "stream": True,
        }
        if system_prompt:
            body["system"] = system_prompt

        headers: dict[str, str] = {
            "Authorization": f"Bearer {self._token()}",
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
        }
        try:
            from bedrock_agentcore import BedrockAgentCoreContext  # type: ignore[import-not-found]
            sid = BedrockAgentCoreContext.get_session_id()
            if sid:
                headers["baggage"] = f"session.id={sid}"
        except Exception:
            pass

        with requests.post(
            self._messages_url,
            headers=headers,
            json=body,
            stream=True,
            timeout=120,
        ) as resp:
            if not resp.ok:
                body_text = resp.text
                log.error("Gateway stream error %s: %s", resp.status_code, body_text)
                resp.raise_for_status()
            for raw_line in resp.iter_lines():
                if not raw_line:
                    continue
                line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line
                if not line.startswith("data:"):
                    continue
                payload = line[len("data:"):].strip()
                if payload in ("", "[DONE]"):
                    continue
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                # Anthropic streaming: content_block_delta with delta.type == "text_delta"
                if event.get("type") == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta":
                        text = delta.get("text", "")
                        if text:
                            yield text


# ── AgentCore Runtime HTTP contract ───────────────────────────────────────────

def _build_app() -> Any:
    from bedrock_agentcore import BedrockAgentCoreApp  # type: ignore[import-not-found]
    from benefits_qa_agent import BenefitsQAAgent, BenefitsQAConfig

    m2m = _load_m2m_secret()
    gateway_url    = _require_env("INFERENCE_GATEWAY_URL") or m2m["gatewayUrl"]
    model_id       = _require_env("INFERENCE_MODEL_ID")
    token_endpoint = m2m["tokenEndpoint"]
    client_id      = m2m["clientId"]
    client_secret  = m2m["clientSecret"]
    scope          = m2m["scope"]
    guardrail_identifier = _require_env("GUARDRAIL_IDENTIFIER")
    guardrail_version  = os.environ.get("GUARDRAIL_VERSION", "DRAFT").strip()
    plan_year          = os.environ.get("PLAN_YEAR", "2026").strip()

    config = BenefitsQAConfig(
        tenant_id="payor",
        agent_id="benefits-qa",
        env_name=os.environ.get("ENV_NAME", "nonprod"),
        inference_profile_arn="",
        guardrail_identifier=guardrail_identifier,
        guardrail_version=guardrail_version,
        plan_year=plan_year,
    )

    llm = _GatewayLLMClient(
        gateway_url=gateway_url,
        model_id=model_id,
        token_endpoint=token_endpoint,
        client_id=client_id,
        client_secret=client_secret,
        scope=scope,
    )

    _state: dict[str, Any] = {}

    def _get_agent() -> BenefitsQAAgent:
        if "agent" not in _state:
            _state["agent"] = BenefitsQAAgent(config=config, llm=llm)
        return _state["agent"]

    app = BedrockAgentCoreApp()

    import uuid as _uuid

    @app.entrypoint
    async def handle(payload: dict[str, Any], context: Any):  # type: ignore[misc]
        thread_id: str = payload.get("threadId", "")
        run_id: str = payload.get("runId", str(_uuid.uuid4()))
        session_messages: list[dict[str, str]] = payload.get("messages", [])
        actor_id: str = payload.get("actorId", "msr-unknown")
        member_id: str = payload.get("memberId", "")

        yield {"type": "RUN_STARTED", "threadId": thread_id, "runId": run_id}

        if not session_messages:
            msg_id = str(_uuid.uuid4())
            yield {"type": "TEXT_MESSAGE_START", "messageId": msg_id, "role": "assistant"}
            yield {"type": "TEXT_MESSAGE_CONTENT", "messageId": msg_id, "delta": "Hello, I'm the Benefits Q&A assistant. How can I help?"}
            yield {"type": "TEXT_MESSAGE_END", "messageId": msg_id}
            yield {"type": "RUN_FINISHED", "threadId": thread_id, "runId": run_id}
            return

        msg_id = str(_uuid.uuid4())
        yield {"type": "TEXT_MESSAGE_START", "messageId": msg_id, "role": "assistant"}

        for delta in _get_agent().stream_reply(
            session_messages,
            actor_id=actor_id,
            member_id=member_id,
        ):
            yield {"type": "TEXT_MESSAGE_CONTENT", "messageId": msg_id, "delta": delta}

        yield {"type": "TEXT_MESSAGE_END", "messageId": msg_id}
        yield {"type": "RUN_FINISHED", "threadId": thread_id, "runId": run_id}

    return app


if __name__ == "__main__":
    log.info(
        "benefits-qa-agent starting | gateway=%s model=%s guardrail=%s plan_year=%s",
        os.environ.get("INFERENCE_GATEWAY_URL", "<unset>"),
        os.environ.get("INFERENCE_MODEL_ID", "<unset>"),
        os.environ.get("GUARDRAIL_IDENTIFIER", "<unset>"),
        os.environ.get("PLAN_YEAR", "2026"),
    )
    app = _build_app()
    app.run(host="0.0.0.0", port=8080)

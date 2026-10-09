"""
benefits-qa-agent — AgenticAI chatbot blueprint, Benefits Q&A pattern.

Extends the agenticai-chatbot-agent base with:
  - PPO benefits knowledge-base grounding (RAG via AgentCore Memory)
  - Structured benefit lookups: deductibles, OOP max, copays, prior auth
  - HITL escalation for coverage disputes and prior-auth decisions
  - Member service rep (MSR) context — internal tool, not member-facing

All guardrail identifiers are required at construction time (R-BED-028).

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable, Protocol

log = logging.getLogger(__name__)

# ── Escalation triggers ────────────────────────────────────────────────────────
# Coverage disputes and prior-auth decisions MUST route to a licensed reviewer.
_HARD_ESCALATION_PHRASES = (
    "coverage dispute",
    "coverage denial",
    "prior authorization",
    "prior auth",
    "appeal",
    "grievance",
    "medical necessity",
    "experimental treatment",
    "hitl_required",
    "<escalate/>",
    "cannot_resolve",
)


class LLMClient(Protocol):
    def invoke(
        self,
        messages: list[dict[str, str]],
        *,
        guardrail_identifier: str,
        guardrail_version: str,
        stream: bool,
    ) -> str: ...


class KnowledgeBaseClient(Protocol):
    """Thin wrapper around AgentCore Memory / Bedrock KB retrieval."""

    def retrieve(self, query: str, *, kb_id: str, top_k: int = 5) -> list[str]: ...


@dataclass(frozen=True)
class BenefitsQAConfig:
    """Runtime configuration for the Benefits Q&A agent.

    Parameters
    ----------
    tenant_id / agent_id / env_name:
        Standard AgenticAI identifiers for cost allocation and tagging.
    inference_profile_arn:
        ApplicationInferenceProfile ARN from the workload stack output.
    guardrail_identifier:
        Bedrock Guardrail ID — mandatory (R-BED-028 + SCP-02).
    kb_id:
        AgentCore Memory / Bedrock Knowledge Base ID for the PPO plan corpus.
    plan_year:
        Plan year string used in context injection, e.g. "2026".
    guardrail_version:
        Defaults to "DRAFT" for non-prod; set "1" (or latest published) in prod.
    max_turns_per_session:
        Hard cap before auto-escalation (prevents runaway conversations).
    stream:
        Whether to enable streaming responses.
    hitl_hand_off:
        Callable invoked with full message history when escalation is triggered.
        Must be wired to the SQS escalation queue at deployment time.
    memory_namespace:
        Optional AgentCore Memory namespace for cross-session recall.
    """

    tenant_id: str
    agent_id: str
    env_name: str
    inference_profile_arn: str
    guardrail_identifier: str
    kb_id: str
    plan_year: str = "2026"
    guardrail_version: str = "DRAFT"
    max_turns_per_session: int = 40
    stream: bool = True
    hitl_hand_off: Callable[[list[dict[str, str]]], None] | None = None
    memory_namespace: str = ""
    top_k_chunks: int = 5

    def __post_init__(self) -> None:
        if not self.guardrail_identifier:
            raise ValueError(
                "guardrail_identifier is mandatory (R-BED-028 + SCP-02 + IAM deny + VPCE policy)"
            )
        if not self.kb_id:
            raise ValueError("kb_id is required — benefits Q&A requires a grounded knowledge base")


@dataclass
class BenefitsQAAgent:
    """Benefits Q&A agent for member service representative (MSR) use.

    The agent answers PPO plan questions grounded in the benefits knowledge
    base. It does NOT make coverage determinations — those require a licensed
    reviewer and trigger HITL escalation automatically.

    Usage
    -----
    Instantiate once per service, call `reply()` per message turn. Pass the
    full session history on each call (stateless design; session state lives
    in the caller).
    """

    config: BenefitsQAConfig
    llm: LLMClient
    kb: KnowledgeBaseClient
    _system_prompt: str = field(default="", init=False, repr=False)

    def __post_init__(self) -> None:
        try:
            import importlib.resources as _res
            pkg = _res.files(__package__ or __name__).joinpath("prompts/system.txt")
            self._system_prompt = pkg.read_text(encoding="utf-8")
        except Exception:
            self._system_prompt = _FALLBACK_SYSTEM_PROMPT

    def reply(
        self,
        session_messages: list[dict[str, str]],
        *,
        actor_id: str,
        member_id: str = "",
    ) -> str:
        """Generate the next assistant turn.

        Parameters
        ----------
        session_messages:
            Full message history for this session (user + assistant alternating).
        actor_id:
            MSR employee ID or SSO subject — required for audit (spec §3.4.6).
        member_id:
            Optional member identifier forwarded to escalation payload for
            lookup continuity. Never logged verbatim (PII — guardrails enforce).
        """
        if not actor_id:
            raise ValueError("actor_id is required (spec §3.4.6) — MSR employee ID or SSO subject")

        if len(session_messages) > self.config.max_turns_per_session * 2:
            return self._escalate(
                session_messages,
                reason="session_length_cap",
                member_id=member_id,
            )

        # Ground the last user message in the benefits KB.
        user_text = _last_user_text(session_messages)
        grounding_chunks = self.kb.retrieve(
            user_text,
            kb_id=self.config.kb_id,
            top_k=self.config.top_k_chunks,
        )

        messages = _inject_context(
            session_messages,
            system_prompt=self._system_prompt,
            grounding_chunks=grounding_chunks,
            plan_year=self.config.plan_year,
        )

        response = self.llm.invoke(
            messages,
            guardrail_identifier=self.config.guardrail_identifier,
            guardrail_version=self.config.guardrail_version,
            stream=self.config.stream,
        )

        if _needs_escalation(response):
            return self._escalate(
                session_messages + [{"role": "assistant", "content": response}],
                reason="escalation_marker",
                member_id=member_id,
            )

        return response

    def _escalate(
        self,
        messages: list[dict[str, str]],
        reason: str,
        member_id: str,
    ) -> str:
        log.info(
            "benefits_qa.escalate reason=%s actor_id=<redacted> member_id=<redacted>",
            reason,
        )
        if self.config.hitl_hand_off:
            payload = list(messages)
            if member_id:
                payload = [{"role": "system", "content": f"member_id_ref={member_id}"}] + payload
            self.config.hitl_hand_off(payload)
        return (
            "This request requires review by a licensed benefits specialist. "
            "I've flagged it for a human agent — they'll follow up shortly. "
            "Is there anything else I can help clarify while you wait?"
        )


# ── Helpers ────────────────────────────────────────────────────────────────────

def _last_user_text(messages: list[dict[str, str]]) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "user":
            return msg.get("content", "")
    return ""


def _needs_escalation(response: str) -> bool:
    lower = response.lower()
    return any(phrase in lower for phrase in _HARD_ESCALATION_PHRASES)


def _inject_context(
    messages: list[dict[str, str]],
    *,
    system_prompt: str,
    grounding_chunks: list[str],
    plan_year: str,
) -> list[dict[str, str]]:
    """Prepend a system turn with the grounded benefits context."""
    context_block = "\n\n".join(grounding_chunks) if grounding_chunks else ""
    full_system = (
        f"{system_prompt}\n\n"
        f"## Plan Year\n{plan_year}\n\n"
        f"## Retrieved Benefits Context\n{context_block}"
    ).strip()
    return [{"role": "system", "content": full_system}] + list(messages)


_FALLBACK_SYSTEM_PROMPT = (
    "You are a benefits Q&A assistant for member service representatives. "
    "Answer only from the retrieved benefits context. "
    "Emit <escalate/> for coverage disputes, prior auth decisions, and anything requiring a licensed reviewer."
)

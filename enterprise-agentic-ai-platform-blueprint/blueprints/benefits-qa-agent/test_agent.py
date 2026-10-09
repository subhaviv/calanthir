"""Unit tests for the benefits-qa-agent blueprint.

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
"""
from __future__ import annotations

import pytest

from benefits_qa_agent import BenefitsQAAgent, BenefitsQAConfig  # type: ignore[import-not-found]


# ── Test doubles ───────────────────────────────────────────────────────────────

class _FakeLLM:
    def __init__(self, response: str) -> None:
        self.response = response
        self.calls: list[dict] = []

    def invoke(self, messages, *, guardrail_identifier, guardrail_version, stream):
        self.calls.append(
            {
                "guardrail_identifier": guardrail_identifier,
                "messages": messages,
                "stream": stream,
            }
        )
        return self.response


class _FakeKB:
    def __init__(self, chunks: list[str] | None = None) -> None:
        self.chunks = chunks or ["In-network primary care copay: $30 per visit."]
        self.calls: list[str] = []

    def retrieve(self, query: str, *, kb_id: str, top_k: int = 5) -> list[str]:
        self.calls.append(query)
        return self.chunks


def _cfg(**overrides) -> BenefitsQAConfig:
    return BenefitsQAConfig(
        tenant_id="payor",
        agent_id="benefits-qa",
        env_name="nonprod",
        inference_profile_arn="arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/test",
        guardrail_identifier="test-guardrail",
        kb_id="test-kb-001",
        **overrides,
    )


def _agent(response: str = "ok", kb_chunks: list[str] | None = None, **cfg_overrides) -> BenefitsQAAgent:
    return BenefitsQAAgent(
        config=_cfg(**cfg_overrides),
        llm=_FakeLLM(response),
        kb=_FakeKB(kb_chunks),
    )


# ── Configuration validation ───────────────────────────────────────────────────

def test_rejects_missing_guardrail():
    with pytest.raises(ValueError, match="guardrail_identifier"):
        BenefitsQAConfig(
            tenant_id="t", agent_id="a", env_name="e",
            inference_profile_arn="arn", guardrail_identifier="", kb_id="kb",
        )


def test_rejects_missing_kb_id():
    with pytest.raises(ValueError, match="kb_id"):
        BenefitsQAConfig(
            tenant_id="t", agent_id="a", env_name="e",
            inference_profile_arn="arn", guardrail_identifier="gd", kb_id="",
        )


def test_rejects_blank_actor_id():
    a = _agent()
    with pytest.raises(ValueError, match="actor_id"):
        a.reply([{"role": "user", "content": "hi"}], actor_id="")


# ── Normal Q&A flow ────────────────────────────────────────────────────────────

def test_basic_reply_returns_response():
    a = _agent(response="Your deductible is $500 in-network.")
    out = a.reply([{"role": "user", "content": "What is my deductible?"}], actor_id="msr-001")
    assert "deductible" in out.lower()


def test_guardrail_identifier_always_forwarded():
    llm = _FakeLLM("ok")
    a = BenefitsQAAgent(config=_cfg(), llm=llm, kb=_FakeKB())
    a.reply([{"role": "user", "content": "hello"}], actor_id="msr-001")
    assert llm.calls[0]["guardrail_identifier"] == "test-guardrail"


def test_kb_is_queried_with_user_text():
    kb = _FakeKB()
    a = BenefitsQAAgent(config=_cfg(), llm=_FakeLLM("ok"), kb=kb)
    a.reply([{"role": "user", "content": "What is the specialist copay?"}], actor_id="msr-001")
    assert kb.calls[-1] == "What is the specialist copay?"


def test_kb_context_injected_into_messages():
    chunks = ["Specialist copay: $60 in-network."]
    llm = _FakeLLM("ok")
    a = BenefitsQAAgent(config=_cfg(), llm=llm, kb=_FakeKB(chunks))
    a.reply([{"role": "user", "content": "Specialist copay?"}], actor_id="msr-001")
    system_content = llm.calls[0]["messages"][0]["content"]
    assert "Specialist copay: $60" in system_content


def test_streams_by_default():
    llm = _FakeLLM("ok")
    a = BenefitsQAAgent(config=_cfg(), llm=llm, kb=_FakeKB())
    a.reply([{"role": "user", "content": "hi"}], actor_id="msr-001")
    assert llm.calls[0]["stream"] is True


# ── Escalation ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("marker", [
    "<escalate/>",
    "HITL_REQUIRED",
    "CANNOT_RESOLVE",
    "prior authorization decision",
    "coverage dispute",
])
def test_escalation_triggers_on_marker(marker: str):
    escalations: list = []
    a = _agent(response=f"I cannot answer. {marker}", hitl_hand_off=escalations.append)
    out = a.reply([{"role": "user", "content": "Is this covered?"}], actor_id="msr-001")
    assert "specialist" in out.lower() or "human" in out.lower()
    assert len(escalations) == 1


def test_session_length_cap_escalates():
    escalations: list = []
    a = _agent(max_turns_per_session=1, hitl_hand_off=escalations.append)
    # 3 messages = over the 1-turn (2-message) cap
    out = a.reply(
        [
            {"role": "user", "content": "q1"},
            {"role": "assistant", "content": "a1"},
            {"role": "user", "content": "q2"},
        ],
        actor_id="msr-001",
    )
    assert "human" in out.lower() or "specialist" in out.lower()
    assert len(escalations) == 1


def test_escalation_without_hitl_handler_returns_message():
    # hitl_hand_off is None — should not raise, just return the escalation string
    a = _agent(response="coverage dispute <escalate/>")
    out = a.reply([{"role": "user", "content": "Dispute my claim"}], actor_id="msr-001")
    assert "specialist" in out.lower() or "human" in out.lower()


def test_member_id_included_in_escalation_payload():
    payloads: list = []
    a = _agent(response="<escalate/>", hitl_hand_off=payloads.append)
    a.reply([{"role": "user", "content": "appeal"}], actor_id="msr-001", member_id="M12345")
    # member_id should appear as a system message prefix
    flat = str(payloads[0])
    assert "M12345" in flat


# ── Plan year context injection ───────────────────────────────────────────────

def test_plan_year_injected_into_system_prompt():
    llm = _FakeLLM("ok")
    a = BenefitsQAAgent(config=_cfg(plan_year="2027"), llm=llm, kb=_FakeKB())
    a.reply([{"role": "user", "content": "hi"}], actor_id="msr-001")
    system_content = llm.calls[0]["messages"][0]["content"]
    assert "2027" in system_content

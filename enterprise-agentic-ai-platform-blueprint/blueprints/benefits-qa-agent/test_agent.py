"""Unit tests for the benefits-qa-agent blueprint.

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
"""
from __future__ import annotations

import pytest

from benefits_qa_agent import BenefitsQAAgent, BenefitsQAConfig  # type: ignore[import-not-found]


class _FakeLLM:
    def __init__(self, response: str) -> None:
        self.response = response
        self.calls: list[dict] = []

    def invoke(self, messages, *, guardrail_identifier, guardrail_version, stream):
        self.calls.append({"guardrail_identifier": guardrail_identifier, "messages": messages, "stream": stream})
        return self.response


def _cfg(**overrides) -> BenefitsQAConfig:
    return BenefitsQAConfig(
        tenant_id="payor",
        agent_id="benefits-qa",
        env_name="nonprod",
        inference_profile_arn="arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/test",
        guardrail_identifier="test-guardrail",
        **overrides,
    )


def _agent(response: str = "ok", **cfg_overrides) -> BenefitsQAAgent:
    return BenefitsQAAgent(config=_cfg(**cfg_overrides), llm=_FakeLLM(response))


# ── Configuration validation ───────────────────────────────────────────────────

def test_rejects_missing_guardrail():
    with pytest.raises(ValueError, match="guardrail_identifier"):
        BenefitsQAConfig(
            tenant_id="t", agent_id="a", env_name="e",
            inference_profile_arn="arn", guardrail_identifier="",
        )


def test_rejects_blank_actor_id():
    with pytest.raises(ValueError, match="actor_id"):
        _agent().reply([{"role": "user", "content": "hi"}], actor_id="")


# ── Normal Q&A flow ────────────────────────────────────────────────────────────

def test_basic_reply_returns_response():
    out = _agent(response="Your deductible is $1,500 in-network.").reply(
        [{"role": "user", "content": "What is my deductible?"}], actor_id="msr-001"
    )
    assert "deductible" in out.lower()


def test_guardrail_identifier_always_forwarded():
    llm = _FakeLLM("ok")
    BenefitsQAAgent(config=_cfg(), llm=llm).reply(
        [{"role": "user", "content": "hello"}], actor_id="msr-001"
    )
    assert llm.calls[0]["guardrail_identifier"] == "test-guardrail"


def test_system_prompt_injected_as_first_message():
    llm = _FakeLLM("ok")
    BenefitsQAAgent(config=_cfg(), llm=llm).reply(
        [{"role": "user", "content": "hi"}], actor_id="msr-001"
    )
    first = llm.calls[0]["messages"][0]
    assert first["role"] == "system"
    assert "PPO" in first["content"]


def test_streams_by_default():
    llm = _FakeLLM("ok")
    BenefitsQAAgent(config=_cfg(), llm=llm).reply(
        [{"role": "user", "content": "hi"}], actor_id="msr-001"
    )
    assert llm.calls[0]["stream"] is True


def test_plan_year_injected_into_system_prompt():
    llm = _FakeLLM("ok")
    BenefitsQAAgent(config=_cfg(plan_year="2027"), llm=llm).reply(
        [{"role": "user", "content": "hi"}], actor_id="msr-001"
    )
    assert "2027" in llm.calls[0]["messages"][0]["content"]


# ── Escalation ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("marker", [
    "<escalate/>",
    "HITL_REQUIRED",
    "CANNOT_RESOLVE",
    "prior authorization decision",
    "coverage dispute",
    "appeal",
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
    out = a.reply(
        [
            {"role": "user", "content": "q1"},
            {"role": "assistant", "content": "a1"},
            {"role": "user", "content": "q2"},
        ],
        actor_id="msr-001",
    )
    assert "specialist" in out.lower() or "human" in out.lower()
    assert len(escalations) == 1


def test_escalation_without_hitl_handler_does_not_raise():
    a = _agent(response="coverage dispute <escalate/>")
    out = a.reply([{"role": "user", "content": "Dispute my claim"}], actor_id="msr-001")
    assert "specialist" in out.lower() or "human" in out.lower()


def test_member_id_included_in_escalation_payload():
    payloads: list = []
    a = _agent(response="<escalate/>", hitl_hand_off=payloads.append)
    a.reply([{"role": "user", "content": "appeal"}], actor_id="msr-001", member_id="M12345")
    assert "M12345" in str(payloads[0])

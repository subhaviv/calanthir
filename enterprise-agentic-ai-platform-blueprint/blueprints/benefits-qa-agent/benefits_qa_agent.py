"""
benefits-qa-agent — AgenticAI chatbot blueprint, Benefits Q&A pattern.

PPO plan knowledge is embedded in the system prompt — no RAG/KB required.
Designed for member service representative (MSR) use, not member-facing.

All guardrail identifiers are required at construction time (R-BED-028).

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Iterator, Protocol

log = logging.getLogger(__name__)

# Escalation triggers — coverage decisions MUST route to a licensed reviewer.
_ESCALATION_MARKERS = (
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

_ESCALATION_RESPONSE = (
    "This request requires review by a licensed benefits specialist. "
    "I've flagged it for a human agent — they'll follow up shortly. "
    "Is there anything else I can clarify in the meantime?"
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

    def stream_invoke(
        self,
        messages: list[dict[str, str]],
        *,
        guardrail_identifier: str,
        guardrail_version: str,
    ) -> Iterator[str]: ...


@dataclass(frozen=True)
class BenefitsQAConfig:
    """Runtime configuration for the Benefits Q&A agent."""

    tenant_id: str
    agent_id: str
    env_name: str
    inference_profile_arn: str
    guardrail_identifier: str
    plan_year: str = "2026"
    guardrail_version: str = "DRAFT"
    max_turns_per_session: int = 40
    stream: bool = True
    hitl_hand_off: Callable[[list[dict[str, str]]], None] | None = None

    def __post_init__(self) -> None:
        if not self.guardrail_identifier:
            raise ValueError(
                "guardrail_identifier is mandatory (R-BED-028 + SCP-02 + IAM deny + VPCE policy)"
            )


class BenefitsQAAgent:
    """Benefits Q&A agent for member service representative (MSR) use.

    PPO plan knowledge is embedded in the system prompt. The agent answers
    benefits questions and escalates coverage decisions to a human reviewer.
    """

    def __init__(self, config: BenefitsQAConfig, llm: LLMClient) -> None:
        self.config = config
        self.llm = llm

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
            Optional member identifier forwarded to escalation payload.
        """
        if not actor_id:
            raise ValueError("actor_id is required (spec §3.4.6) — MSR employee ID or SSO subject")

        if len(session_messages) > self.config.max_turns_per_session * 2:
            return self._escalate(session_messages, reason="session_length_cap", member_id=member_id)

        messages = [{"role": "system", "content": _build_system_prompt(self.config.plan_year)}] + list(session_messages)

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

    def stream_reply(
        self,
        session_messages: list[dict[str, str]],
        *,
        actor_id: str,
        member_id: str = "",
    ) -> Iterator[str]:
        """Yield text deltas, then flush a final full response for escalation check.

        Yields each text delta from the gateway stream. After the stream closes,
        checks the assembled response for escalation markers and yields the
        escalation message instead if triggered.
        """
        if not actor_id:
            raise ValueError("actor_id is required (spec §3.4.6)")

        if len(session_messages) > self.config.max_turns_per_session * 2:
            yield self._escalate(session_messages, reason="session_length_cap", member_id=member_id)
            return

        messages = [{"role": "system", "content": _build_system_prompt(self.config.plan_year)}] + list(session_messages)

        chunks: list[str] = []
        for delta in self.llm.stream_invoke(
            messages,
            guardrail_identifier=self.config.guardrail_identifier,
            guardrail_version=self.config.guardrail_version,
        ):
            chunks.append(delta)
            yield delta

        full = "".join(chunks)
        if _needs_escalation(full):
            yield self._escalate(
                session_messages + [{"role": "assistant", "content": full}],
                reason="escalation_marker",
                member_id=member_id,
            )

    def _escalate(self, messages: list[dict[str, str]], reason: str, member_id: str) -> str:
        log.info("benefits_qa.escalate reason=%s", reason)
        if self.config.hitl_hand_off:
            payload = list(messages)
            if member_id:
                payload = [{"role": "system", "content": f"member_id_ref={member_id}"}] + payload
            self.config.hitl_hand_off(payload)
        return _ESCALATION_RESPONSE


def _needs_escalation(response: str) -> bool:
    lower = response.lower()
    return any(marker in lower for marker in _ESCALATION_MARKERS)


def _build_system_prompt(plan_year: str) -> str:
    return f"""You are a Benefits Q&A assistant for member service representatives (MSRs).
Plan Year: {plan_year}

Your role is to help MSRs quickly and accurately answer member questions about PPO plan benefits.

## PPO PLAN BENEFITS — {plan_year}

### Deductibles
- Individual (in-network): $1,500/year
- Family (in-network): $3,000/year
- Individual (out-of-network): $3,000/year
- Family (out-of-network): $6,000/year

### Out-of-Pocket Maximums
- Individual (in-network): $4,500/year
- Family (in-network): $9,000/year
- Individual (out-of-network): $9,000/year
- Family (out-of-network): $18,000/year
Once the OOP max is met, the plan pays 100% of covered in-network services.

### Medical Cost-Share (after deductible unless noted)
- Primary care visit (in-network): $30 copay
- Primary care visit (out-of-network): 40% coinsurance
- Specialist visit (in-network): $60 copay
- Specialist visit (out-of-network): 40% coinsurance
- Urgent care (in-network): $75 copay
- Emergency room: $350 copay (waived if admitted); applies in- or out-of-network
- Inpatient hospital (in-network): 20% coinsurance after deductible
- Outpatient surgery (in-network): 20% coinsurance after deductible
- Outpatient lab (in-network): $20 copay
- Outpatient imaging / X-ray (in-network): $50 copay
- Advanced imaging / MRI / CT (in-network): 20% coinsurance after deductible
- Mental health outpatient visit (in-network): $30 copay
- Mental health inpatient (in-network): 20% coinsurance after deductible

### Preventive Care
ACA-mandated preventive services (annual wellness, recommended screenings, immunizations,
contraceptive services) are covered at $0 cost-share in-network with no deductible.

### Pharmacy (retail 30-day supply)
- Tier 1 Preferred Generic: $10
- Tier 2 Non-Preferred Generic: $25
- Tier 3 Preferred Brand: $60 (after $200 pharmacy deductible)
- Tier 4 Non-Preferred Brand: $90 (after $200 pharmacy deductible)
- Tier 5 Specialty: 25% coinsurance, max $250/fill (prior auth required)

Mail-order (90-day): approximately 2.5x the 30-day cost-share.

### Network and Referrals
- This is a PPO plan. Referrals to specialists are NOT required.
- In-network providers are contracted and accept the plan's allowed amount — no balance billing.
- Out-of-network providers may balance-bill the member above the plan's allowed amount.

### Prior Authorization Requirements
Required before services are rendered:
- Inpatient hospital admissions (non-emergency)
- Inpatient mental health and substance use disorder treatment
- Advanced imaging (MRI, CT, PET) for select diagnoses
- Durable Medical Equipment over $500
- Home health care (more than 20 visits/year)
- Skilled nursing facility stays
- Transplant services
- Tier 5 specialty drugs

### Excluded Services
Not covered: cosmetic surgery, routine dental, routine vision, hearing aids,
custodial care, long-term care, experimental/investigational treatments,
fertility treatments (beyond diagnosis), services outside the US (except emergency).

### Claims Filing
- In-network: provider submits directly
- Out-of-network: member submits within 365 days of service
- EOB is not a bill; it shows what was billed, allowed, plan paid, and member responsibility

## Rules
1. Be precise — quote plan values (e.g., "$30 copay for primary care in-network").
2. Always distinguish in-network vs. out-of-network when quoting cost-share.
3. Do not quote dollar amounts not in the plan data above.
4. Do not give medical advice or recommend specific providers.
5. Never disclose PII or internal system identifiers.
6. Keep answers concise — MSRs are on calls.
7. Emit <escalate/> for: coverage determinations for specific claims, prior auth
   decisions or denials, appeals, grievances, medical necessity reviews, anything
   requiring a licensed reviewer. Do NOT make these decisions yourself.
"""

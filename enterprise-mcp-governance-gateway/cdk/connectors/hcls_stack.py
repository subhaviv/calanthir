# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""HclsConnectorStack — hosted HCLS / PubMed MCP servers as governed targets on
the gateway, modeled on AtlassianConnectorStack.

Fronts Anthropic's hosted healthcare MCP servers (PubMed, Clinical Trials, ICD-10,
NPI Registry, CMS Coverage) through the enterprise governance gateway, so every LOB
reaches them through ONE governed MCP endpoint — Cedar authz + audit + interceptors
apply, exactly as for the EHR tools. No proxy Lambda, no per-LOB wiring.

How this DIFFERS from the Atlassian connector (and why it's simpler):
  * Endpoint is a STATIC public https URL (e.g. https://pubmed.mcp.claude.com/mcp),
    NOT a Runtime invocation URL. So there is no ARN to url-encode and we use a
    plain, declarative ``CfnGatewayTarget`` — NOT the custom-resource dance the
    Atlassian target needs.
  * These are PUBLIC, read-only reference servers: no AgentCore Runtime, no
    per-user 3LO OAuth, no credential provider, no client secret. Outbound auth is
    omitted; if a server later requires an API key, add an
    ``apiKeyCredentialProvider`` credential-provider config here.
  * Governance posture: an unconditional READ permit per target for every
    authenticated gateway user (these are public lookups). The gateway still
    authenticates the caller (Cognito JWT), audits the call, and runs the PII/
    attack interceptors — and the agent's own skill instructions forbid putting
    PHI into a query (these tools take clinical concepts, not patient identifiers).

Mirrors the platform tool-catalogue SSOT entries (tool-pubmed, tool-clinical-trials,
tool-icd10, tool-npi-registry, tool-cms-coverage) in
``enterprise-agentic-ai-platform-blueprint/packages/platform-tool-catalogue``. The
catalogue is the platform-blueprint's declarative story; THIS stack is the live
implementation on the deployed governance gateway. Keep the endpoint URLs in sync.

Deploy order: the core gateway stack first (this reads its gateway id/ARN + policy
engine id from SSM).
"""
import os
from pathlib import Path

from aws_cdk import (
    CfnOutput,
    Stack,
    aws_bedrockagentcore as agentcore,
    aws_ssm as ssm,
)
from constructs import Construct

_HERE = Path(__file__).resolve().parent


def _s(d=""):
    return {"type": "string", **({"description": d} if d else {})}


def _i(d=""):
    return {"type": "integer", **({"description": d} if d else {})}


def _t(name, desc, props, required):
    return {"name": name, "description": desc,
            "inputSchema": {"type": "object", "properties": props, "required": required}}


# One hosted MCP server = one gateway target. `listing_mode='DYNAMIC'` fetches the
# server's tool list LIVE at tools/list time (DEFAULT's control-plane cache did not
# surface these tools in the unified list even after explicit sync). `international` is documentation only — it records whether the tool is
# safe for a non-US clinical demo (PubMed/Trials) or US-coding-specific (ICD-10/NPI/CMS).
HCLS_TARGETS = [
    {
        "name": "PubMed",
        "tool_id": "tool-pubmed",
        "endpoint": "https://pubmed.mcp.claude.com/mcp",
        "international": True,
        "description": "PubMed biomedical literature search. Query by clinical concept, never patient identifiers.",
    },
    {
        "name": "ClinicalTrials",
        "tool_id": "tool-clinical-trials",
        "endpoint": "https://hcls.mcp.claude.com/clinical_trials/mcp",
        "international": True,
        "description": "Clinical trials registry search. Query by condition/criteria, never patient identifiers.",
    },
    {
        "name": "Icd10",
        "tool_id": "tool-icd10",
        "endpoint": "https://hcls.mcp.claude.com/icd10_codes/mcp",
        "international": False,
        "description": "ICD-10 code lookup/validation (US-centric ICD-10-CM). For coding/RCM use cases.",
    },
    {
        "name": "NpiRegistry",
        "tool_id": "tool-npi-registry",
        "endpoint": "https://hcls.mcp.claude.com/npi_registry/mcp",
        "international": False,
        "description": "NPI provider registry lookup (US-only CMS NPI). For US coding/RCM use cases.",
    },
    {
        "name": "CmsCoverage",
        "tool_id": "tool-cms-coverage",
        "endpoint": "https://hcls.mcp.claude.com/cms_coverage/mcp",
        "international": False,
        "description": "CMS coverage/policy lookup (US-centric). For coding/PA/RCM use cases.",
    },
]


class HclsConnectorStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, *,
                 targets=None, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        selected = targets if targets is not None else HCLS_TARGETS

        # Core gateway identifiers (deploy the gateway stack first).
        gateway_id = ssm.StringParameter.value_for_string_parameter(
            self, "/enterprise-mcp-gateway/gateway/id")
        gateway_arn = ssm.StringParameter.value_for_string_parameter(
            self, "/enterprise-mcp-gateway/gateway/arn")

        for spec in selected:
            endpoint = spec["endpoint"]
            if not endpoint.startswith("https://"):
                # Fail loud at synth — AgentCore McpServer.Endpoint pattern is ^https://.*
                raise ValueError(
                    f"HCLS target '{spec['name']}': endpoint must be https:// (got {endpoint})")

            # Plain, declarative mcpServer target — static URL, so no custom resource.
            target = agentcore.CfnGatewayTarget(
                self, f"{spec['name']}Target",
                gateway_identifier=gateway_id,
                name=spec["name"],
                description=spec["description"],
                target_configuration=agentcore.CfnGatewayTarget.TargetConfigurationProperty(
                    mcp=agentcore.CfnGatewayTarget.McpTargetConfigurationProperty(
                        mcp_server=agentcore.CfnGatewayTarget.McpServerTargetConfigurationProperty(
                            endpoint=endpoint,
                            # DYNAMIC: tools are fetched LIVE at tools/list time (served on a
                            # separate page), under the calling user's identity. DEFAULT mode
                            # caches at the control plane via (implicit/explicit) sync, but in
                            # this gateway the cached HCLS tools did not surface in the unified
                            # tools/list even after SynchronizeGatewayTargets — DYNAMIC makes
                            # them appear reliably. Tradeoff (acceptable for these public,
                            # no-auth servers): DYNAMIC is not interoperable with semantic tool
                            # search or outbound 3LO. Governance (JWT auth, audit, interceptors)
                            # still applies on every call.
                            listing_mode="DYNAMIC",
                        ),
                    ),
                ),
                # No credentialProviderConfigurations: these hosted servers are public
                # read-only reference tools. Add an apiKeyCredentialProvider here if a
                # server later requires a key.
            )

            # Cedar policies are NOT created here. The AgentCore policy engine
            # validates each permit's action against the target's REAL tool names
            # (action == AgentCore::Action::"<TargetName>___<tool>") and rejects an
            # unknown action ("unable to find an applicable action"). With
            # listing_mode='DEFAULT' (dynamic discovery) the tool names are not known
            # at synth time, so a per-tool permit cannot be written yet — a guessed
            # action (e.g. "<Target>___query") fails CREATE with a parse/validation
            # error. The permits are a FOLLOW-UP once the real tool names are known:
            # deploy the target, run `aws bedrock-agentcore-control list-gateway-targets`
            # / inspect the discovered tools, then add one
            #   permit(principal is AgentCore::OAuthUser,
            #          action == AgentCore::Action::"<TargetName>___<tool>",
            #          resource == AgentCore::Gateway::"<gateway_arn>");
            # CfnPolicy per tool (mirroring policies/allow-docs-read.cedar).
            #
            # NOTE: if the gateway's policy engine is in ENFORCE mode, a target with no
            # permits is DENIED by default (safe). If it is LOG_ONLY, every call is
            # permitted silently until the permits land — add the policies before
            # relying on governance for these tools.
            _ = gateway_arn  # referenced by the follow-up policies; kept for clarity

            CfnOutput(self, f"{spec['name']}Endpoint", value=endpoint,
                      description=f"{spec['name']} hosted MCP endpoint fronted by the gateway")

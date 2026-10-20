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


# One hosted MCP server = one gateway target. `listing_mode='DEFAULT'` discovers +
# caches the server's tools via synchronization (works now the gateway supports
# protocol version 2025-06-18). The policy engine is ENFORCE, so each tool needs an
# explicit Cedar permit or it is denied-by-default AND hidden from tools/list — hence
# the `tools` list below, used to emit one read permit per tool. Tool names are the
# servers' REAL tool names (verified by calling each hosted server's tools/list).
# `international` is documentation only — whether the target is safe for a non-US
# clinical demo (PubMed/Trials) or US-coding-specific (ICD-10/NPI/CMS).
HCLS_TARGETS = [
    {
        "name": "PubMed",
        "tool_id": "tool-pubmed",
        "endpoint": "https://pubmed.mcp.claude.com/mcp",
        "international": True,
        "description": "PubMed biomedical literature search. Query by clinical concept, never patient identifiers.",
        "tools": ["search_articles", "get_article_metadata", "find_related_articles",
                  "lookup_article_by_citation", "convert_article_ids",
                  "get_full_text_article", "get_copyright_status"],
    },
    {
        "name": "ClinicalTrials",
        "tool_id": "tool-clinical-trials",
        "endpoint": "https://hcls.mcp.claude.com/clinical_trials/mcp",
        "international": True,
        "description": "Clinical trials registry search. Query by condition/criteria, never patient identifiers.",
        "tools": ["search_trials", "get_trial_details", "search_by_sponsor",
                  "search_investigators", "analyze_endpoints", "search_by_eligibility"],
    },
    {
        "name": "Icd10",
        "tool_id": "tool-icd10",
        "endpoint": "https://hcls.mcp.claude.com/icd10_codes/mcp",
        "international": False,
        "description": "ICD-10 code lookup/validation (US-centric ICD-10-CM). For coding/RCM use cases.",
        "tools": ["lookup_code", "search_codes", "validate_code", "get_hierarchy",
                  "get_by_category", "get_by_body_system"],
    },
    {
        "name": "NpiRegistry",
        "tool_id": "tool-npi-registry",
        "endpoint": "https://hcls.mcp.claude.com/npi_registry/mcp",
        "international": False,
        "description": "NPI provider registry lookup (US-only CMS NPI). For US coding/RCM use cases.",
        "tools": ["npi_validate", "npi_lookup", "npi_search"],
    },
    {
        "name": "CmsCoverage",
        "tool_id": "tool-cms-coverage",
        "endpoint": "https://hcls.mcp.claude.com/cms_coverage/mcp",
        "international": False,
        "description": "CMS coverage/policy lookup (US-centric). For coding/PA/RCM use cases.",
        "tools": ["search_national_coverage", "search_local_coverage", "get_coverage_document",
                  "get_contractors", "get_whats_new_report", "batch_get_ncds", "sad_exclusion_list"],
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
        policy_engine_id = ssm.StringParameter.value_for_string_parameter(
            self, "/enterprise-mcp-gateway/policy-engine/id")

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
                            # DEFAULT: tools are discovered + cached via synchronization
                            # (implicit on create/update, explicit via SynchronizeGatewayTargets).
                            # This works now that the gateway's supportedVersions include
                            # 2025-06-18 (the version these hosted servers speak) — the earlier
                            # empty tools/list was that version gap, NOT the listing mode.
                            # DEFAULT (vs DYNAMIC) keeps semantic tool search available.
                            listing_mode="DEFAULT",
                        ),
                    ),
                ),
                # No credentialProviderConfigurations: these hosted servers are public
                # read-only reference tools. Add an apiKeyCredentialProvider here if a
                # server later requires a key.
            )

            # One Cedar permit per REAL tool. The policy engine is ENFORCE, so a tool
            # with no permit is denied-by-default AND hidden from tools/list (confirmed
            # live: a call to PubMed___search_articles returned "No policy applies ...
            # denied by default" until these permits existed). The action MUST be
            # "<TargetName>___<realToolName>" — the engine validates it against the
            # target's discovered tools and rejects an unknown action, which is why an
            # earlier guessed "<Target>___query" failed. Unconditional read permit for
            # every authenticated gateway user — these are public reference tools; the
            # gateway still authenticates + audits + interceptor-scans each call, and the
            # agent's skill instructions forbid PHI in a query.
            for tool in spec.get("tools", []):
                action = f"{spec['name']}___{tool}"
                statement = (
                    "permit(\n"
                    "  principal is AgentCore::OAuthUser,\n"
                    f'  action == AgentCore::Action::"{action}",\n'
                    f'  resource == AgentCore::Gateway::"{gateway_arn}"\n'
                    ");"
                )
                pol = agentcore.CfnPolicy(
                    self, f"Policy{spec['name']}{tool.title().replace('_', '')}",
                    policy_engine_id=policy_engine_id,
                    name=f"hcls_{spec['tool_id'].replace('-', '_')}_{tool}",
                    definition={"cedar": {"statement": statement}},
                    validation_mode="IGNORE_ALL_FINDINGS",  # unconditional read permit is intentional
                )
                pol.node.add_dependency(target)

            CfnOutput(self, f"{spec['name']}Endpoint", value=endpoint,
                      description=f"{spec['name']} hosted MCP endpoint fronted by the gateway")

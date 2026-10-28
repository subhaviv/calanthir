# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Agent MCP gateway: the machine-caller twin of the enterprise (user) gateway.

The enterprise gateway admits HUMAN users (loom browser/CLI clients, Cedar on
``cognito:groups``). This gateway admits AGENTS, which authenticate with their
own Loom M2M (client-credentials) access token. Both use the same loom IdP and
both are JWT; they are split because a gateway has exactly one inbound
authorizer and AgentCore ANDs its fields, so one gateway cannot say "user
clients OR agents holding scope X".

Authorization follows the Cognito M2M model — what a machine identity may do is
carried in its access token's custom SCOPES, granted to its client in the IdP:

* This stack owns an ``agent-gateway`` resource server on the loom pool with one
  scope per tool (``agent-gateway/tool.<tool>``).
* The gateway authorizer admits a token only if it holds one of those scopes
  (``allowedScopes``) — onboarding an agent is granting its client a scope, with
  no change to this stack.
* Cedar then permits each tool ONLY to tokens holding THAT tool's scope.

Targets:

* ``DeciderAPI`` — the Strands Decider Lambda (owned by StrandsDeciderStack),
  imported by ARN, same tool schema as on the user gateway.
* ``enterprise-agent-context`` — the COA agent-MCP runtime (M2M wrapper), reached with
  OAuth client-credentials through an AgentCore Identity credential provider
  holding this gateway's OWN loom client (granted ``coa/group.enterprise-agent-context``).
  Off until ``agentGatewayCoaRuntimeArn`` is set, because COA must first accept
  scope-authorized clients (its agent_mcp_enforce_scopes rollout).
"""
from __future__ import annotations

import json
import urllib.parse
from pathlib import Path

from aws_cdk import (
    CfnOutput,
    Fn,
    Stack,
    aws_bedrockagentcore as agentcore,
    aws_cognito as cognito,
    aws_iam as iam,
    aws_lambda as lambda_,
    aws_secretsmanager as secretsmanager,
    aws_ssm as ssm,
)
from constructs import Construct

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMAS_DIR = REPO_ROOT / "schemas"

GATEWAY_NAME = "agent-mcp-gateway"
POLICY_ENGINE_NAME = "agent_mcp_policy_engine"
RESOURCE_SERVER = "agent-gateway"
SSM_PREFIX = "/agent-mcp-gateway"

# Scope per tool. Cedar permits each tool only to tokens holding its scope.
DECIDER_SCOPE = f"{RESOURCE_SERVER}/tool.decider"
CONTEXT_SCOPE = f"{RESOURCE_SERVER}/tool.enterprise-agent-context"

# The COA scope this gateway's own client is granted (COA maps it to its
# `enterprise-agent-context` group; see COA's agent-mcp scope-based authorization).
COA_GATEWAY_SCOPE = "coa/group.enterprise-agent-context"
COA_TARGET_NAME = "enterprise-agent-context"
COA_PROVIDER_NAME = "agent-gateway-coa"


def _cedar_scope_permit(action: str, scope: str, gateway_arn: str) -> str:
    """Single-action permit for tokens whose space-separated scope claim holds ``scope``.

    The scope claim is matched as a whole space-delimited token (start, middle or
    end of the string) so `tool.decider` cannot be satisfied by a longer scope
    that merely contains it.
    """
    return (
        "permit(\n"
        "  principal is AgentCore::OAuthUser,\n"
        f'  action == AgentCore::Action::"{action}",\n'
        f'  resource == AgentCore::Gateway::"{gateway_arn}"\n'
        ")\n"
        "when {\n"
        '  principal.hasTag("scope") && (\n'
        f'    principal.getTag("scope") == "{scope}" ||\n'
        f'    principal.getTag("scope") like "{scope} *" ||\n'
        f'    principal.getTag("scope") like "* {scope}" ||\n'
        f'    principal.getTag("scope") like "* {scope} *"\n'
        "  )\n"
        "};"
    )


class AgentGatewayStack(Stack):
    """Machine-caller MCP gateway on the loom IdP (JWT, scope-authorized)."""

    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        ctx = self.node.try_get_context
        self.user_pool_id: str = ctx("authUserPoolId")
        if not self.user_pool_id:
            raise ValueError("authUserPoolId context (the loom pool id) is required")
        decider_arn = (ctx("deciderLambdaArn") or "").strip()
        if not decider_arn:
            raise ValueError("deciderLambdaArn context is required for the agent gateway")
        coa_runtime_arn = (ctx("agentGatewayCoaRuntimeArn") or "").strip()

        self.discovery_url = (
            f"https://cognito-idp.{self.region}.amazonaws.com/"
            f"{self.user_pool_id}/.well-known/openid-configuration"
        )
        pool = cognito.UserPool.from_user_pool_id(self, "LoomPool", self.user_pool_id)

        # 1. Tool scopes on the loom pool (this stack's own resource server).
        resource_server = cognito.CfnUserPoolResourceServer(
            self,
            "AgentGatewayScopes",
            user_pool_id=self.user_pool_id,
            identifier=RESOURCE_SERVER,
            name="Agent MCP gateway",
            scopes=[
                cognito.CfnUserPoolResourceServer.ResourceServerScopeTypeProperty(
                    scope_name="tool.decider",
                    scope_description="Call the Strands Decider tool",
                ),
                cognito.CfnUserPoolResourceServer.ResourceServerScopeTypeProperty(
                    scope_name="tool.enterprise-agent-context",
                    scope_description="Call the enterprise-agent-context (COA) tools",
                ),
            ],
        )

        # 2. Targets' Lambdas + gateway execution role.
        decider_fn = lambda_.Function.from_function_attributes(
            self, "DeciderFn", function_arn=decider_arn, same_environment=True
        )
        self.gateway_role = iam.Role(
            self,
            "AgentGatewayExecRole",
            assumed_by=iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
            description="Agent MCP gateway execution role",
        )
        self.gateway_role.add_to_policy(
            iam.PolicyStatement(
                sid="InvokeTargetLambdas",
                actions=["lambda:InvokeFunction"],
                resources=[decider_arn, f"{decider_arn}:*"],
            )
        )
        # Same enforcement grant as the user gateway (see its PolicyEngineEnforcement
        # note on why gateway/* rather than the exact ARN: avoids a Role<->Gateway cycle).
        self.gateway_role.add_to_policy(
            iam.PolicyStatement(
                sid="PolicyEngineEnforcement",
                actions=[
                    "bedrock-agentcore:GetPolicyEngine",
                    "bedrock-agentcore:AuthorizeAction",
                    "bedrock-agentcore:PartiallyAuthorizeActions",
                ],
                resources=[
                    f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:gateway/*",
                ],
            )
        )

        # 3. Cedar policy engine.
        self.policy_engine = agentcore.CfnPolicyEngine(
            self,
            "PolicyEngine",
            name=POLICY_ENGINE_NAME,
            description="Cedar policy engine for the agent MCP gateway",
        )
        self.gateway_role.add_to_policy(
            iam.PolicyStatement(
                sid="PolicyEngineScoped",
                actions=[
                    "bedrock-agentcore:GetPolicyEngine",
                    "bedrock-agentcore:AuthorizeAction",
                    "bedrock-agentcore:PartiallyAuthorizeActions",
                ],
                resources=[self.policy_engine.attr_policy_engine_arn],
            )
        )

        # 4. Gateway: CUSTOM_JWT on loom, admitting ONLY agent-gateway tool scopes.
        #    No interceptors: this gateway fronts no PHI-bearing tool, and the
        #    PHI-masking response interceptor belongs with the user gateway's EHR.
        self.gateway = agentcore.CfnGateway(
            self,
            "Gateway",
            name=GATEWAY_NAME,
            description="Agent MCP gateway (machine callers, scope-authorized)",
            role_arn=self.gateway_role.role_arn,
            protocol_type="MCP",
            authorizer_type="CUSTOM_JWT",
            authorizer_configuration=agentcore.CfnGateway.AuthorizerConfigurationProperty(
                custom_jwt_authorizer=agentcore.CfnGateway.CustomJWTAuthorizerConfigurationProperty(
                    discovery_url=self.discovery_url,
                    allowed_scopes=[DECIDER_SCOPE, CONTEXT_SCOPE],
                ),
            ),
            policy_engine_configuration=agentcore.CfnGateway.GatewayPolicyEngineConfigurationProperty(
                arn=self.policy_engine.attr_policy_engine_arn,
                mode="ENFORCE",
            ),
            protocol_configuration=agentcore.CfnGateway.GatewayProtocolConfigurationProperty(
                mcp=agentcore.CfnGateway.MCPGatewayConfigurationProperty(
                    supported_versions=["2025-11-25", "2025-06-18", "2025-03-26"],
                ),
            ),
            exception_level="DEBUG",
        )
        self.gateway.node.add_dependency(self.gateway_role)
        self.gateway.add_dependency(resource_server)

        # Confused-deputy guard: only THIS gateway may invoke the Decider via the
        # service principal.
        decider_fn.add_permission(
            "AgentGatewayInvoke",
            principal=iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
            action="lambda:InvokeFunction",
            source_arn=self.gateway.attr_gateway_arn,
        )

        # 5. Targets.
        targets: list[agentcore.CfnGatewayTarget] = []
        decider_target = agentcore.CfnGatewayTarget(
            self,
            "DeciderApiTarget",
            name="DeciderAPI",
            description="Strands Decider (Lambda owned by StrandsDeciderStack)",
            gateway_identifier=self.gateway.attr_gateway_identifier,
            target_configuration=agentcore.CfnGatewayTarget.TargetConfigurationProperty(
                mcp=agentcore.CfnGatewayTarget.McpTargetConfigurationProperty(
                    lambda_=agentcore.CfnGatewayTarget.McpLambdaTargetConfigurationProperty(
                        lambda_arn=decider_arn,
                        tool_schema=agentcore.CfnGatewayTarget.ToolSchemaProperty(
                            inline_payload=_tool_definitions("decider-tools.json"),
                        ),
                    ),
                ),
            ),
            credential_provider_configurations=[
                agentcore.CfnGatewayTarget.CredentialProviderConfigurationProperty(
                    credential_provider_type="GATEWAY_IAM_ROLE",
                )
            ],
        )
        targets.append(decider_target)
        policy_statements: list[tuple[str, str]] = [
            ("decider_scope", _cedar_scope_permit(
                "DeciderAPI___decide", DECIDER_SCOPE, self.gateway.attr_gateway_arn)),
        ]

        if coa_runtime_arn:
            coa_target = self._create_coa_target(pool, coa_runtime_arn)
            targets.append(coa_target)
            # COA tool names are discovered from the runtime (dynamic listing), so
            # they are permitted per tool once known via agentGatewayCoaTools
            # (JSON array, or a comma-separated string from `-c`).
            raw_tools = ctx("agentGatewayCoaTools") or []
            if isinstance(raw_tools, str):
                raw_tools = (
                    json.loads(raw_tools) if raw_tools.strip().startswith("[")
                    else raw_tools.split(",")
                )
            for tool in [str(t).strip() for t in raw_tools if str(t).strip()]:
                policy_statements.append((
                    f"enterprise_agent_context_{tool}",
                    _cedar_scope_permit(
                        f"{COA_TARGET_NAME}___{tool}", CONTEXT_SCOPE, self.gateway.attr_gateway_arn),
                ))

        # 6. Cedar policies, after every target (targets populate the Cedar schema).
        for name, statement in policy_statements:
            policy = agentcore.CfnPolicy(
                self,
                f"Policy_{name}",
                name=f"agent_gw_{name}".replace("-", "_"),
                policy_engine_id=self.policy_engine.attr_policy_engine_id,
                definition=agentcore.CfnPolicy.PolicyDefinitionProperty(
                    cedar=agentcore.CfnPolicy.CedarPolicyProperty(statement=statement),
                ),
                validation_mode="IGNORE_ALL_FINDINGS",
            )
            for target in targets:
                policy.add_dependency(target)

        # 7. Discovery values (non-secret).
        for suffix, value in {
            "gateway/url": self.gateway.attr_gateway_url,
            "gateway/id": self.gateway.attr_gateway_identifier,
            "gateway/arn": self.gateway.attr_gateway_arn,
            "policy-engine/id": self.policy_engine.attr_policy_engine_id,
            "scopes/decider": DECIDER_SCOPE,
            "scopes/enterprise-agent-context": CONTEXT_SCOPE,
        }.items():
            ssm.StringParameter(
                self,
                "Param" + suffix.replace("/", "-").title().replace("-", ""),
                parameter_name=f"{SSM_PREFIX}/{suffix}",
                string_value=value,
            )
        CfnOutput(self, "AgentGatewayUrl", value=self.gateway.attr_gateway_url)
        CfnOutput(self, "DeciderScope", value=DECIDER_SCOPE)
        CfnOutput(self, "EnterpriseAgentContextScope", value=CONTEXT_SCOPE)

    def _create_coa_target(
        self, pool: cognito.IUserPool, coa_runtime_arn: str
    ) -> agentcore.CfnGatewayTarget:
        """`enterprise-agent-context` -> COA agent-MCP runtime, OAuth client-credentials.

        The gateway's OWN loom client (granted the COA scope) is wrapped in an
        AgentCore Identity credential provider; the gateway fetches its token per
        call. The client secret is copied into a Secrets Manager secret that the
        provider REFERENCES (clientSecretSource EXTERNAL), so it never appears in
        the template. Requires COA's `coa/group.enterprise-agent-context` scope to exist.
        """
        client = cognito.UserPoolClient(
            self,
            "CoaClient",
            user_pool=pool,
            user_pool_client_name="agent-gateway-coa",
            generate_secret=True,
            auth_flows=cognito.AuthFlow(),
            o_auth=cognito.OAuthSettings(
                flows=cognito.OAuthFlows(client_credentials=True),
                scopes=[cognito.OAuthScope.custom(COA_GATEWAY_SCOPE)],
            ),
        )
        secret = secretsmanager.Secret(
            self,
            "CoaClientSecret",
            secret_name="agent-mcp-gateway/coa-client",
            description="Client secret of the agent gateway's COA (loom M2M) client",
            secret_object_value={"clientSecret": client.user_pool_client_secret},
        )
        provider = agentcore.CfnOAuth2CredentialProvider(
            self,
            "CoaCredentialProvider",
            name=COA_PROVIDER_NAME,
            credential_provider_vendor="CustomOauth2",
            oauth2_provider_config_input=agentcore.CfnOAuth2CredentialProvider.Oauth2ProviderConfigInputProperty(
                custom_oauth2_provider_config=agentcore.CfnOAuth2CredentialProvider.CustomOauth2ProviderConfigInputProperty(
                    client_id=client.user_pool_client_id,
                    client_secret_source="EXTERNAL",
                    client_secret_config=agentcore.CfnOAuth2CredentialProvider.SecretReferenceProperty(
                        secret_id=secret.secret_arn,
                        json_key="clientSecret",
                    ),
                    oauth_discovery=agentcore.CfnOAuth2CredentialProvider.Oauth2DiscoveryProperty(
                        discovery_url=self.discovery_url,
                    ),
                ),
            ),
        )
        # Token vault read for this one provider + its referenced secret.
        self.gateway_role.add_to_policy(
            iam.PolicyStatement(
                sid="CoaProviderToken",
                actions=[
                    "bedrock-agentcore:GetWorkloadAccessToken",
                    "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
                    "bedrock-agentcore:GetResourceOauth2Token",
                ],
                resources=[
                    f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:token-vault/default",
                    f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:token-vault/default/oauth2credentialprovider/{COA_PROVIDER_NAME}",
                    f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:workload-identity-directory/default",
                    f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:workload-identity-directory/default/workload-identity/*",
                ],
            )
        )
        secret.grant_read(self.gateway_role)

        encoded_arn = urllib.parse.quote(coa_runtime_arn, safe="")
        endpoint = (
            f"https://bedrock-agentcore.{self.region}.amazonaws.com/runtimes/"
            f"{encoded_arn}/invocations?qualifier=DEFAULT"
        )
        target = agentcore.CfnGatewayTarget(
            self,
            "EnterpriseAgentContextTarget",
            name=COA_TARGET_NAME,
            description="Context Ontology Accelerator (agent-MCP runtime) via M2M OAuth",
            gateway_identifier=self.gateway.attr_gateway_identifier,
            target_configuration=agentcore.CfnGatewayTarget.TargetConfigurationProperty(
                mcp=agentcore.CfnGatewayTarget.McpTargetConfigurationProperty(
                    mcp_server=agentcore.CfnGatewayTarget.McpServerTargetConfigurationProperty(
                        endpoint=endpoint,
                    ),
                ),
            ),
            credential_provider_configurations=[
                agentcore.CfnGatewayTarget.CredentialProviderConfigurationProperty(
                    credential_provider_type="OAUTH",
                    credential_provider=agentcore.CfnGatewayTarget.CredentialProviderProperty(
                        oauth_credential_provider=agentcore.CfnGatewayTarget.OAuthCredentialProviderProperty(
                            provider_arn=provider.attr_credential_provider_arn,
                            scopes=[COA_GATEWAY_SCOPE],
                        ),
                    ),
                )
            ],
        )
        target.add_dependency(provider)
        return target


def _tool_definitions(schema_file: str) -> list:
    """Load schemas/<file> into ToolDefinitionProperty objects (same as the user gateway)."""

    def _schema(node: dict) -> agentcore.CfnGatewayTarget.SchemaDefinitionProperty:
        kwargs: dict = {"type": node["type"]}
        if "description" in node:
            kwargs["description"] = node["description"]
        if "properties" in node:
            kwargs["properties"] = {k: _schema(v) for k, v in node["properties"].items()}
        if "required" in node:
            kwargs["required"] = node["required"]
        if "items" in node:
            kwargs["items"] = _schema(node["items"])
        return agentcore.CfnGatewayTarget.SchemaDefinitionProperty(**kwargs)

    data = json.loads((SCHEMAS_DIR / schema_file).read_text())
    return [
        agentcore.CfnGatewayTarget.ToolDefinitionProperty(
            name=t["name"],
            description=t.get("description", ""),
            input_schema=_schema(t["inputSchema"]),
        )
        for t in data["tools"]
    ]

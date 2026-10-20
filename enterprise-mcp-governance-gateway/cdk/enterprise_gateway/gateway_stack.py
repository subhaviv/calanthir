# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Enterprise MCP Governance Gateway stack (Amazon Bedrock AgentCore).

CDK port of the original boto3 deployer (since removed). Resources are added
incrementally in the dependency order below; critically, the gateway targets must
exist before the Cedar policies that reference them (the policy engine derives its
schema from the registered tools).

Ported: all 8 slices - IAM, the four Lambdas, the Cognito identity slice
(user pool, admin-auth client, resource server, Secrets Manager credential), the
Cedar policy engine, the Gateway (CUSTOM_JWT + interceptors + ENFORCE), the two
gateway targets, the Cedar policies (ordered after targets), and the SSM
+ CfnOutput discovery values. Per-Lambda exec roles are CDK-managed;
demo-user records + permanent-password set run in a post-deploy seed script;
KMS encryption, hosted domain, and M2M client are tracked enhancements.
"""
import json
from pathlib import Path

from constructs import Construct

from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    aws_bedrock as bedrock,
    aws_bedrockagentcore as agentcore,
    aws_cognito as cognito,
    aws_ec2 as ec2,
    aws_iam as iam,
    aws_kms as kms,
    aws_lambda as lambda_,
    aws_secretsmanager as secretsmanager,
    aws_ssm as ssm,
)

# Repo root: gateway_stack.py -> enterprise_gateway -> cdk -> <repo root>.
REPO_ROOT = Path(__file__).resolve().parents[2]
LAMBDAS_DIR = REPO_ROOT / "lambdas"
SCHEMAS_DIR = REPO_ROOT / "schemas"

# Gateway targets: target name (becomes the tool prefix "<Name>___<tool>") ->
# (construct id, lambda logical key, tool-schema file under schemas/).
TARGET_DEFS = {
    "DocsAPI": ("DocsApiTarget", "docs_target", "docs-tools.json"),
    "DatabaseAPI": ("DatabaseApiTarget", "database_target", "database-tools.json"),
    "EhrAPI": ("EhrApiTarget", "ehr_target", "ehr-tools.json"),
}

MANIFEST_PATH = REPO_ROOT / "policies" / "manifest.json"


def _split_cedar_statements(text: str) -> list[str]:
    """Split a Cedar source file into individual statements.

    Ported from the original boto3 deployer: each CfnPolicy accepts exactly ONE
    Cedar statement, so multi-statement .cedar files must be split. A statement
    ends at a ';' at brace/paren depth 0 outside a string literal; leading line
    comments stay with the statement they precede.
    """
    statements: list[str] = []
    buf: list[str] = []
    depth = 0
    in_str = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if not in_str and ch == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            if j == -1:
                j = n
            buf.append(text[i:j])
            i = j
            continue
        buf.append(ch)
        if ch == '"' and (i == 0 or text[i - 1] != "\\"):
            in_str = not in_str
        elif not in_str:
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth -= 1
            elif ch == ";" and depth == 0:
                stmt = "".join(buf).strip()
                if stmt:
                    statements.append(stmt)
                buf = []
        i += 1
    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return [
        s
        for s in statements
        if any(
            line.strip() and not line.strip().startswith("//")
            for line in s.splitlines()
        )
    ]

# AgentCore resource names (match the reference deployer). Policy-engine name must
# match ^[A-Za-z][A-Za-z0-9_]*$ (underscores, no hyphens). Gateway name must match
# ^([0-9a-zA-Z][-]?){1,100}$.
POLICY_ENGINE_NAME = "enterprise_mcp_policy_engine"
GATEWAY_NAME = "enterprise-mcp-gateway"

# Logical key -> (construct id, source dir relative to lambdas/). Interceptors and
# sample targets are stdlib-only, so a plain source-zip asset matches the
# reference deployer's zip behavior (no bundling needed).
LAMBDA_DEFS = {
    "request_interceptor": ("RequestInterceptor", "request-interceptor"),
    "response_interceptor": ("ResponseInterceptor", "response-interceptor"),
    "docs_target": ("DocsTarget", "tool-targets/docs-server"),
    "database_target": ("DatabaseTarget", "tool-targets/database-server"),
    "ehr_target": ("EhrTarget", "tool-targets/ehr-server"),
}


class EnterpriseGatewayStack(Stack):
    """Single-stack deployment of the governed MCP gateway.

    Resource creation order (dependency-driven):
      1. IAM roles ............. gateway exec (lambda exec roles are CDK-managed)   [DONE]
      2. Lambdas ............... request/response interceptors + docs/database targets [DONE]
      3. Cognito + Secrets Mgr . pool, resource server, admin-auth client, demo credential in Secrets Manager [DONE; domain/M2M deferred; users via seed script]
      4. PolicyEngine .......... CfnPolicyEngine, encrypted with the customer-managed KMS key [DONE]
      5. Gateway ............... CfnGateway: CUSTOM_JWT + 2 interceptors + ENFORCE policy engine; SourceArn-pinned invoke; CMK-encrypted [DONE]
      6. GatewayTargets ........ DocsAPI, DatabaseAPI - registering tools builds the Cedar schema [DONE]
      7. Policies .............. CfnPolicy x N, each add_dependency(target) (Risk #1) [DONE]
      8. SSM + CfnOutputs ...... non-secret discovery values (Risk #3) [DONE]
    """

    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # 0. Bedrock Guardrail (managed) — content filters + PII anonymization the
        #    interceptors apply via ApplyGuardrail. Created first so the Lambdas can
        #    reference its id/version and get bedrock:ApplyGuardrail scoped to it.
        self.guardrail = self._create_guardrail()

        # 1-2. Lambdas (CDK-managed least-privilege exec roles) + gateway exec role.
        self.functions = self._create_lambdas()
        self.gateway_role = self._create_gateway_role(self.functions)
        self._wire_guardrail_to_interceptors()

        # 2b. Customer-managed KMS key for encryption at rest. Created after the gateway
        #     role because the gateway's half of the key policy names that role as the
        #     principal. One key encrypts the gateway, the Cedar policy engine (and all
        #     its policies), and the demo credential secret.
        self.encryption_key = self._create_encryption_key()

        # 3. Identity: Cognito user pool + admin-auth app client
        #    (ADMIN_USER_PASSWORD_AUTH; no public USER_PASSWORD_AUTH, no third-party
        #    SRP dependency), plus the demo credential generated into Secrets Manager.
        #    The user *records* + permanent-password set run in a post-deploy seed
        #    script (Option B), deferred until after the SSM/outputs slice (Risk #3),
        #    since that script consumes the published discovery values.
        self.user_pool, self.user_pool_client = self._create_cognito()

        # Authorizer identity source = the imported loom IdP (see _create_cognito).
        # The Cedar policies match on cognito:groups, which is pool-agnostic.
        self.auth_user_pool_id = self.user_pool.user_pool_id
        self.auth_client_ids = [self.user_pool_client.user_pool_client_id]

        # 4. Cedar policy engine, encrypted with the customer-managed key.
        self.policy_engine = self._create_policy_engine()

        # Least privilege: scope the policy-engine half of the enforcement grant to THIS
        # engine's exact ARN. Added here (not in _create_gateway_role) because the role is
        # created first; the engine has no dependency on the role, so referencing its ARN
        # is safe (unlike the gateway ARN — see PolicyEngineEnforcement for why).
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

        # 5. Gateway: CUSTOM_JWT inbound auth + REQUEST/RESPONSE interceptors +
        #    the policy engine attached in ENFORCE mode. Then pin Lambda invoke to
        #    THIS gateway (confused-deputy protection) via SourceArn.
        self.gateway = self._create_gateway()
        # The gateway calls GetPolicyEngine WITH its exec role during creation, so it
        # must wait for the role's INLINE POLICY (PolicyEngineAccess), not just the
        # role. Referencing role_arn only deps the Role, letting CfnGateway race the
        # DefaultPolicy -> "Access denied while calling GetPolicyEngine" (seen at
        # deploy). Depending on the role construct pulls in its DefaultPolicy too.
        self.gateway.node.add_dependency(self.gateway_role)
        self._grant_gateway_invoke()

        # 6. Gateway targets (DocsAPI, DatabaseAPI). Registering these populates the
        #    policy engine's Cedar schema, so the policies (step 7) depend on them.
        self.targets = self._create_targets()

        # 7. Cedar policies. Each depends on BOTH targets so the engine's Cedar
        #    schema is populated before any policy referencing a tool is created
        #    (Risk #1: declarative ordering instead of the original deployer's heal loop).
        self.policies = self._create_policies()

        # 8. Publish non-secret discovery values to SSM Parameter Store (source of
        #    truth, replacing DEPLOY_STATE.json) + CfnOutputs (Risk #3). The demo
        #    credential itself stays in Secrets Manager (Risk #2).
        self._publish_discovery()

    # ------------------------------------------------------------------
    # 2. Lambdas
    # ------------------------------------------------------------------
    def _create_lambdas(self) -> dict[str, lambda_.Function]:
        """Create the four Lambdas (2 interceptors + 2 sample targets).

        Each gets a CDK-managed execution role granting only CloudWatch Logs
        (AWS-managed basic execution) — least privilege, matching the reference
        deployer where the sample targets touch no other AWS service.
        """
        functions: dict[str, lambda_.Function] = {}
        # EHR target is VPC-attached (reaches the private HAPI ALB) and gets the
        # FHIR base URL; sourced from context with the live agentops-ehr-fhir
        # stack outputs as defaults. Other targets are networkless.
        ehr_vpc_id = self.node.try_get_context("ehrVpcId") or "vpc-0e92aea5ffbbfbf8b"
        ehr_subnets = (
            self.node.try_get_context("ehrPrivateSubnetIds")
            or "subnet-029ce493bd50f36cd,subnet-060ad5a6c7192a9f0"
        ).split(",")
        ehr_sg_id = self.node.try_get_context("ehrSecurityGroupId") or "sg-0ad61e5de45435bed"
        ehr_fhir_base = (
            self.node.try_get_context("ehrFhirBaseUrl")
            or "http://internal-ehr-fhir-nonprod-1007114648.us-east-1.elb.amazonaws.com/fhir"
        )
        ehr_vpc = ec2.Vpc.from_vpc_attributes(
            self,
            "EhrVpc",
            vpc_id=ehr_vpc_id,
            availability_zones=[f"{self.region}a", f"{self.region}b"],
            private_subnet_ids=[s.strip() for s in ehr_subnets if s.strip()],
        )
        ehr_sg = ec2.SecurityGroup.from_security_group_id(self, "EhrSg", ehr_sg_id)

        for key, (cid, src) in LAMBDA_DEFS.items():
            extra = {}
            if key == "ehr_target":
                extra = dict(
                    vpc=ehr_vpc,
                    vpc_subnets=ec2.SubnetSelection(subnets=ehr_vpc.private_subnets),
                    security_groups=[ehr_sg],
                    environment={"FHIR_BASE_URL": ehr_fhir_base},
                )
            functions[key] = lambda_.Function(
                self,
                cid,
                runtime=lambda_.Runtime.PYTHON_3_12,
                handler="index.handler",
                code=lambda_.Code.from_asset(str(LAMBDAS_DIR / src)),
                timeout=Duration.seconds(30),
                memory_size=256,
                description=f"Enterprise MCP gateway: {cid} (CDK)",
                **extra,
            )
        return functions

    # ------------------------------------------------------------------
    # 0. Bedrock Guardrail (managed content/PII controls for the interceptors)
    # ------------------------------------------------------------------
    def _create_guardrail(self) -> bedrock.CfnGuardrail:
        """Managed Amazon Bedrock Guardrail the interceptors enforce via ApplyGuardrail.

        Makes the custom interceptor controls **managed**: instead of (only) hand-rolled
        regex, the request path runs INPUT through prompt-attack / denied-topic filters
        and the response path runs OUTPUT through PII anonymization. The local regex
        rules remain as defense-in-depth. PII entities use ANONYMIZE so the response is
        masked (not hard-blocked), matching the existing [REDACTED_*] behavior.
        """
        return bedrock.CfnGuardrail(
            self,
            "McpGuardrail",
            name="enterprise-mcp-guardrail",
            description="Managed content + PII guardrail for the MCP gateway interceptors",
            blocked_input_messaging="Request blocked by the enterprise guardrail.",
            blocked_outputs_messaging="Response blocked by the enterprise guardrail.",
            content_policy_config=bedrock.CfnGuardrail.ContentPolicyConfigProperty(
                filters_config=[
                    # PROMPT_ATTACK only supports INPUT filtering — output_strength NONE.
                    bedrock.CfnGuardrail.ContentFilterConfigProperty(
                        type="PROMPT_ATTACK", input_strength="HIGH", output_strength="NONE"
                    ),
                    bedrock.CfnGuardrail.ContentFilterConfigProperty(
                        type="MISCONDUCT", input_strength="HIGH", output_strength="HIGH"
                    ),
                ],
            ),
            sensitive_information_policy_config=bedrock.CfnGuardrail.SensitiveInformationPolicyConfigProperty(
                pii_entities_config=[
                    bedrock.CfnGuardrail.PiiEntityConfigProperty(type=t, action="ANONYMIZE")
                    for t in ("EMAIL", "PHONE", "US_SOCIAL_SECURITY_NUMBER",
                              "CREDIT_DEBIT_CARD_NUMBER", "NAME", "ADDRESS")
                ],
            ),
        )

    def _wire_guardrail_to_interceptors(self) -> None:
        """Give the two interceptor Lambdas the guardrail id/version + ApplyGuardrail.

        Env-gated in the Lambda code: with GUARDRAIL_ID set the interceptors call the
        managed guardrail; unset, they fall back to the local regex rules only.
        """
        guardrail_arn = self.guardrail.attr_guardrail_arn
        guardrail_id = self.guardrail.attr_guardrail_id
        for key in ("request_interceptor", "response_interceptor"):
            fn = self.functions[key]
            fn.add_environment("GUARDRAIL_ID", guardrail_id)
            fn.add_environment("GUARDRAIL_VERSION", "DRAFT")
            fn.add_to_role_policy(
                iam.PolicyStatement(
                    sid="ApplyGuardrail",
                    actions=["bedrock:ApplyGuardrail"],
                    resources=[guardrail_arn],
                )
            )

    # ------------------------------------------------------------------
    # 1. Gateway execution role
    # ------------------------------------------------------------------
    def _create_gateway_role(
        self, functions: dict[str, lambda_.Function]
    ) -> iam.Role:
        """Gateway execution role assumed by bedrock-agentcore.amazonaws.com.

        Two scoped grants:
          * lambda:InvokeFunction on the 4 target/interceptor functions (+ version
            qualifiers).
          * Policy-engine evaluation at request time. NOTE (carried from the
            reference deployer / README): a narrower action list than the service
            wildcard yields "Insufficient Permissions for Policy Evaluation" and
            breaks ENFORCE (verified live). The blast radius is constrained by
            RESOURCE scoping to this account's policy-engine/* and gateway/* only.
            PRODUCTION: monitor CloudTrail and replace the wildcard with the exact
            action list once AWS documents it.
        """
        role = iam.Role(
            self,
            "GatewayExecRole",
            assumed_by=iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
            description="AgentCore gateway execution role",
        )

        invoke_resources: list[str] = []
        for fn in functions.values():
            invoke_resources.append(fn.function_arn)
            invoke_resources.append(f"{fn.function_arn}:*")
        role.add_to_policy(
            iam.PolicyStatement(
                sid="InvokeLambdas",
                actions=["lambda:InvokeFunction"],
                resources=invoke_resources,
            )
        )

        role.add_to_policy(
            iam.PolicyStatement(
                sid="PolicyEngineEnforcement",
                # Runtime Cedar enforcement only. Per AWS docs (policy-permissions), the
                # gateway exec role needs GetPolicyEngine (load the engine) plus
                # AuthorizeAction / PartiallyAuthorizeActions (evaluate each tools/call and
                # filter tools/list). This replaces an earlier bedrock-agentcore:* wildcard —
                # narrowing WITHOUT the two authorize actions is what previously caused
                # "Insufficient Permissions for Policy Evaluation".
                #
                # WHY `gateway/*` AND NOT THIS GATEWAY'S EXACT ARN: the gateway must wait
                # for this role's inline policy (it calls GetPolicyEngine with this role at
                # creation time — see add_dependency on the role in the constructor), so the
                # policy CANNOT reference the gateway ARN without creating a circular
                # dependency (Policy -> Gateway -> Role/Policy). The account+region scoping
                # is therefore the tightest achievable boundary for the gateway resource.
                # The policy engine IS scoped to its exact ARN — see PolicyEngineScoped,
                # added after the engine is created.
                #
                # KNOWN LIMITATION (single-gateway sample): this stack deploys ONE gateway,
                # so in practice `gateway/*` resolves to just this gateway. If your account
                # runs MULTIPLE gateways in this region, this role could evaluate policy
                # against those gateways too. For production multi-gateway accounts, tighten
                # it one of two ways:
                #   1. After deploy, update this statement to the specific gateway ARN
                #      (e.g. via a follow-up `cdk deploy` once the ARN is known, or an
                #      out-of-band policy update), or
                #   2. Use a two-phase deployment: create the gateway first, then update the
                #      role policy with the exact gateway ARN in a second pass.
                # See "Tracked production hardening" in README.md.
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

        # Outbound-OAuth (per-user 3LO) for MCP connector targets. The gateway fetches
        # each user's vaulted token to inject into the connector's mcpServer call.
        # Granted ONCE here, scoped by the `mcp-connector-*` provider naming convention,
        # so future connectors (Atlassian, GitHub, …) need no further core-stack change.
        # Least privilege: only the token-vault read actions, only on connector providers.
        #
        # INTENTIONAL WILDCARD (`mcp-connector-*`): this is a deliberate extensibility
        # boundary, not an oversight. Connector stacks are deployed independently of this
        # core stack, so their provider ARNs are not known here; the naming convention IS
        # the security boundary (only providers named `mcp-connector-*` are reachable, and
        # only with read actions). If you deploy a FIXED set of connectors and want the
        # tightest possible policy, replace the prefix with each provider's exact ARN.
        role.add_to_policy(
            iam.PolicyStatement(
                sid="ConnectorTokenVault",
                actions=[
                    "bedrock-agentcore:GetWorkloadAccessToken",
                    "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
                    "bedrock-agentcore:GetResourceOauth2Token",
                ],
                resources=[
                    f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:token-vault/default",
                    f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:token-vault/default/oauth2credentialprovider/mcp-connector-*",
                    f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:workload-identity-directory/default",
                    f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:workload-identity-directory/default/workload-identity/*",
                ],
            )
        )
        # AgentCore stores each OAuth provider's client secret in its own managed
        # Secrets Manager secret; the gateway reads it to perform the token exchange.
        #
        # REQUIRED WILDCARD: AgentCore Identity creates and names these secrets itself
        # (`bedrock-agentcore-identity!default/oauth2/<provider>`), so their full ARNs do
        # not exist at synth time and cannot be enumerated here. The grant is narrowed as
        # far as the service allows: read-only, only within AgentCore's own managed secret
        # namespace, and only for providers following the `mcp-connector-*` convention —
        # it cannot read any other secret in the account (e.g. the demo user credential).
        role.add_to_policy(
            iam.PolicyStatement(
                sid="ConnectorProviderSecret",
                actions=["secretsmanager:GetSecretValue"],
                resources=[
                    f"arn:aws:secretsmanager:{self.region}:{self.account}:secret:"
                    "bedrock-agentcore-identity!default/oauth2/mcp-connector-*",
                ],
            )
        )
        return role

    # ------------------------------------------------------------------
    # 3. Cognito (sample IdP; production uses customer OIDC federation)
    # ------------------------------------------------------------------
    def _create_encryption_key(self) -> kms.Key:
        """Customer-managed KMS key encrypting the gateway, policy engine and secret.

        AgentCore encrypts at rest with a service-managed key by default; a
        customer-managed key (CMK) adds control over the key policy, rotation on your own
        schedule, and CloudTrail auditing of key use. The two services need *different*
        grant shapes, both taken from the AgentCore docs:

        * **Gateway** — grants go to the gateway's own service role, gated by
          ``kms:ViaService`` and an encryption-context condition naming the gateway ARN.
          See https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-encryption.html
        * **Policy engine** — creates two grants (management + evaluation) by calling
          ``kms:CreateGrant`` with *your* identity through a Forward Access Session, so
          the permission must be granted to the **account principal**, not a service
          principal. See
          https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-encryption.html

        Note the encryption-context conditions use a ``gateway/*`` / ``policy-engine/*``
        pattern rather than the exact ARNs: the resources are created *after* this key and
        reference it, so naming them here would be a circular dependency. The conditions
        still constrain use to this account, this region, and only via AgentCore.
        """
        key = kms.Key(
            self,
            "EncryptionKey",
            alias="alias/enterprise-mcp-gateway",
            description="CMK for the enterprise MCP gateway, Cedar policy engine and demo secret",
            enable_key_rotation=True,  # annual automatic rotation
            removal_policy=RemovalPolicy.DESTROY,  # demo: cdk destroy schedules deletion
        )

        via_agentcore = {"kms:ViaService": f"bedrock-agentcore.{self.region}.amazonaws.com"}
        gateway_ctx = (
            f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:gateway/*"
        )

        # --- Gateway: DescribeKey / Decrypt+GenerateDataKey / CreateGrant -------------
        key.add_to_resource_policy(
            iam.PolicyStatement(
                sid="AllowGatewayServiceRoleDescribeKey",
                principals=[iam.ArnPrincipal(self.gateway_role.role_arn)],
                actions=["kms:DescribeKey"],
                resources=["*"],
                conditions={"StringEquals": via_agentcore},
            )
        )
        key.add_to_resource_policy(
            iam.PolicyStatement(
                sid="AllowGatewayServiceRoleDecrypt",
                principals=[iam.ArnPrincipal(self.gateway_role.role_arn)],
                actions=["kms:Decrypt", "kms:GenerateDataKey"],
                resources=["*"],
                conditions={
                    "StringEquals": via_agentcore,
                    "StringLike": {
                        "kms:EncryptionContext:aws:bedrock-agentcore-gateway:arn": gateway_ctx
                    },
                },
            )
        )
        key.add_to_resource_policy(
            iam.PolicyStatement(
                sid="AllowGatewayServiceRoleCreateGrant",
                principals=[iam.ArnPrincipal(self.gateway_role.role_arn)],
                actions=["kms:CreateGrant"],
                resources=["*"],
                conditions={
                    "StringEquals": {
                        **via_agentcore,
                        "kms:GrantConstraintType": "EncryptionContextSubset",
                    },
                    "ForAllValues:StringEquals": {
                        "kms:GrantOperations": ["Decrypt", "GenerateDataKey"]
                    },
                    "StringLike": {
                        "kms:EncryptionContext:aws:bedrock-agentcore-gateway:arn": gateway_ctx
                    },
                },
            )
        )

        # --- Policy engine: granted to the ACCOUNT principal (Forward Access Session) --
        key.add_to_resource_policy(
            iam.PolicyStatement(
                sid="AllowPolicyEngineViaForwardAccessSession",
                principals=[iam.AccountRootPrincipal()],
                actions=[
                    "kms:CreateGrant",
                    "kms:Decrypt",
                    "kms:GenerateDataKey",
                    "kms:DescribeKey",
                ],
                resources=["*"],
                conditions={"StringEquals": via_agentcore},
            )
        )

        # The key policy above is necessary but NOT sufficient: AgentCore assumes the
        # gateway execution role and calls KMS with it, so the role needs the same actions
        # on its IDENTITY policy too. Without this the gateway fails to create with
        # "Failed to encrypt data with the Gateway encryption key … no identity-based
        # policy allows the kms:GenerateDataKey action" (verified).
        key.grant_encrypt_decrypt(self.gateway_role)
        self.gateway_role.add_to_policy(
            iam.PolicyStatement(
                sid="GatewayEncryptionKeyGrants",
                effect=iam.Effect.ALLOW,
                actions=["kms:CreateGrant", "kms:DescribeKey"],
                resources=[key.key_arn],
            )
        )
        return key

    # ------------------------------------------------------------------
    # 3. Identity
    # ------------------------------------------------------------------
    def _create_cognito(self) -> tuple[cognito.IUserPool, cognito.IUserPoolClient]:
        """Import the enterprise IdP (loom) — the gateway creates NO pool of its own.

        In this platform there is exactly ONE identity provider: the loom /
        Calanthir Cognito pool (``us-east-1_NoErXe1QA``). Every component — the
        Calanthir app, this gateway, the agents, M2M callers — authenticates
        against it, so a clinician login in the Calanthir UI flows straight
        through to the governed EHR tool with the same token.

        The pool id and app-client id come from CDK context (``authUserPoolId`` /
        ``authClientId``), defaulted in ``cdk.json`` to the loom pool. They are
        IMPORTED (read-only ``from_user_pool_id`` / ``from_user_pool_client_id``):
        the gateway owns no identity resources, it only TRUSTS the one issuer.
        Demo users, the ``clinical-staff`` group and passwords are managed IN loom
        (by the seed script / console), not by this stack.

        The Cedar policies match on ``cognito:groups`` (pool-agnostic), so pointing
        at loom needs no policy change.
        """
        pool_id = self.node.try_get_context("authUserPoolId")
        client_id = self.node.try_get_context("authClientId")
        if not pool_id or not client_id:
            raise ValueError(
                "authUserPoolId and authClientId context are required — "
                "the gateway imports the loom enterprise IdP and creates no pool. "
                "Defaults live in cdk.json; override with -c if needed."
            )

        pool = cognito.UserPool.from_user_pool_id(self, "LoomUserPool", pool_id)
        client = cognito.UserPoolClient.from_user_pool_client_id(
            self, "LoomUserPoolClient", client_id
        )
        return pool, client

    # ------------------------------------------------------------------
    # 4. Cedar policy engine
    # ------------------------------------------------------------------
    def _create_policy_engine(self) -> agentcore.CfnPolicyEngine:
        """Create the Cedar policy engine.

        Parity with the reference deployer's create_policy_engine. The Gateway
        (step 5) references ``attr_policy_engine_arn`` in its
        policyEngineConfiguration; the Cedar policies (step 7) reference
        ``attr_policy_engine_id`` and depend on the targets (step 6) so the engine
        schema is populated before policies are created (Risk #1).
        Encrypted with the stack's customer-managed KMS key. Note the API cannot change
        or remove a policy engine's key afterwards, and CloudFormation treats a change to
        ``EncryptionKeyArn`` as a *replacement*.
        """
        return agentcore.CfnPolicyEngine(
            self,
            "PolicyEngine",
            name=POLICY_ENGINE_NAME,
            description="Cedar policy engine for enterprise MCP gateway",
            encryption_key_arn=self.encryption_key.key_arn,
        )

    # ------------------------------------------------------------------
    # 5. Gateway
    # ------------------------------------------------------------------
    def _create_gateway(self) -> agentcore.CfnGateway:
        """Create the AgentCore MCP gateway.

        Inbound auth = CUSTOM_JWT against the user pool's OIDC discovery URL,
        restricted to our app client. REQUEST + RESPONSE interceptor Lambdas are
        attached (max 2 interceptors per the L1 spec - we use exactly that). The
        Cedar policy engine is attached in ENFORCE mode. ``exception_level=DEBUG``
        returns verbose denial reasons (good for the demo); lower/omit it for
        production (tracked as the env-config enhancement).
        """
        self.discovery_url = (
            f"https://cognito-idp.{self.region}.amazonaws.com/"
            f"{self.auth_user_pool_id}/.well-known/openid-configuration"
        )

        def _interceptor(point: str, fn: lambda_.Function):
            return agentcore.CfnGateway.GatewayInterceptorConfigurationProperty(
                interception_points=[point],
                interceptor=agentcore.CfnGateway.InterceptorConfigurationProperty(
                    lambda_=agentcore.CfnGateway.LambdaInterceptorConfigurationProperty(
                        arn=fn.function_arn,
                    ),
                ),
                input_configuration=agentcore.CfnGateway.InterceptorInputConfigurationProperty(
                    pass_request_headers=True,
                ),
            )

        return agentcore.CfnGateway(
            self,
            "Gateway",
            name=GATEWAY_NAME,
            description="Enterprise MCP governance gateway",
            role_arn=self.gateway_role.role_arn,
            kms_key_arn=self.encryption_key.key_arn,
            protocol_type="MCP",
            authorizer_type="CUSTOM_JWT",
            authorizer_configuration=agentcore.CfnGateway.AuthorizerConfigurationProperty(
                custom_jwt_authorizer=agentcore.CfnGateway.CustomJWTAuthorizerConfigurationProperty(
                    discovery_url=self.discovery_url,
                    allowed_clients=self.auth_client_ids,
                ),
            ),
            interceptor_configurations=[
                _interceptor("REQUEST", self.functions["request_interceptor"]),
                _interceptor("RESPONSE", self.functions["response_interceptor"]),
            ],
            policy_engine_configuration=agentcore.CfnGateway.GatewayPolicyEngineConfigurationProperty(
                arn=self.policy_engine.attr_policy_engine_arn,
                mode="ENFORCE",
            ),
            # MCP protocol versions. 2025-11-25 is required for OAuth URL-elicitation
            # (the per-user 3LO consent used by connector targets like Atlassian);
            # 2025-06-18 is required for the hosted HCLS/PubMed MCP-server targets,
            # which advertise protocolVersion 2025-06-18 — without it the gateway and
            # those servers share no common version, the forwarded handshake returns
            # nothing, and their tools/list comes back empty (symptom seen live);
            # 2025-03-26 retained for backward compatibility with older MCP clients.
            protocol_configuration=agentcore.CfnGateway.GatewayProtocolConfigurationProperty(
                mcp=agentcore.CfnGateway.MCPGatewayConfigurationProperty(
                    supported_versions=["2025-11-25", "2025-06-18", "2025-03-26"],
                ),
            ),
            exception_level="DEBUG",
        )

    def _grant_gateway_invoke(self) -> None:
        """Permit ONLY this gateway to invoke the 4 Lambdas (confused-deputy guard).

        The AgentCore service principal is pinned via ``SourceArn`` = this
        gateway's ARN, so no other gateway in the account can invoke these
        functions. (The gateway role's identity policy from step 1 already covers
        the role-based path; this is the resource-based service-principal grant the
        service uses at invoke time.) Adding it after the gateway is correct —
        invoke is only exercised at tool-call time.
        """
        for fn in self.functions.values():
            fn.add_permission(
                "AgentCoreInvoke",
                principal=iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
                action="lambda:InvokeFunction",
                source_arn=self.gateway.attr_gateway_arn,
            )

    # ------------------------------------------------------------------
    # 6. Gateway targets (MCP Lambda targets)
    # ------------------------------------------------------------------
    def _create_targets(self) -> dict[str, agentcore.CfnGatewayTarget]:
        """Register the DocsAPI and DatabaseAPI Lambda targets.

        Each loads its tool schema from schemas/*.json and exposes tools as
        ``<TargetName>___<tool>``. Credential type GATEWAY_IAM_ROLE means the
        gateway invokes the Lambda with its own execution role. Registering a
        target is what adds its tools to the policy engine's Cedar schema, so the
        Cedar policies (step 7) will depend on these targets (Risk #1).
        """
        targets: dict[str, agentcore.CfnGatewayTarget] = {}
        for target_name, (cid, fn_key, schema_file) in TARGET_DEFS.items():
            targets[target_name] = agentcore.CfnGatewayTarget(
                self,
                cid,
                name=target_name,
                description=f"{target_name} Lambda target",
                gateway_identifier=self.gateway.attr_gateway_identifier,
                target_configuration=agentcore.CfnGatewayTarget.TargetConfigurationProperty(
                    mcp=agentcore.CfnGatewayTarget.McpTargetConfigurationProperty(
                        lambda_=agentcore.CfnGatewayTarget.McpLambdaTargetConfigurationProperty(
                            lambda_arn=self.functions[fn_key].function_arn,
                            tool_schema=agentcore.CfnGatewayTarget.ToolSchemaProperty(
                                inline_payload=self._tool_definitions(schema_file),
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
        return targets

    def _tool_definitions(
        self, schema_file: str
    ) -> list["agentcore.CfnGatewayTarget.ToolDefinitionProperty"]:
        """Load schemas/<file> and convert each tool to a ToolDefinitionProperty.

        The schema files use MCP/JSON-schema camelCase (``inputSchema``); the L1
        constructs need typed ``ToolDefinitionProperty``/``SchemaDefinitionProperty``
        objects, so we map rather than pass the raw dicts.
        """
        data = json.loads((SCHEMAS_DIR / schema_file).read_text())
        return [
            agentcore.CfnGatewayTarget.ToolDefinitionProperty(
                name=tool["name"],
                description=tool.get("description", ""),
                input_schema=self._schema_definition(tool["inputSchema"]),
                output_schema=(
                    self._schema_definition(tool["outputSchema"])
                    if "outputSchema" in tool
                    else None
                ),
            )
            for tool in data["tools"]
        ]

    def _schema_definition(
        self, node: dict
    ) -> "agentcore.CfnGatewayTarget.SchemaDefinitionProperty":
        """Recursively convert a JSON-schema node to a SchemaDefinitionProperty."""
        kwargs: dict = {"type": node["type"]}
        if "description" in node:
            kwargs["description"] = node["description"]
        if "properties" in node:
            kwargs["properties"] = {
                key: self._schema_definition(val)
                for key, val in node["properties"].items()
            }
        if "required" in node:
            kwargs["required"] = node["required"]
        if "items" in node:
            kwargs["items"] = self._schema_definition(node["items"])
        return agentcore.CfnGatewayTarget.SchemaDefinitionProperty(**kwargs)

    # ------------------------------------------------------------------
    # 7. Cedar policies (Risk #1: ordered after targets)
    # ------------------------------------------------------------------
    def _create_policies(self) -> list[agentcore.CfnPolicy]:
        """Create the active Cedar policies, one CfnPolicy per statement.

        Reads policies/manifest.json (the active ``policies`` only; the disabled
        GitHub/Atlassian set references unregistered tools and would fail schema
        validation). ``__GATEWAY_ARN__`` is substituted with the gateway ARN token,
        and each .cedar file is split into single statements (CfnPolicy takes one).

        Risk #1: every policy ``add_dependency``s BOTH targets, so CloudFormation
        creates the targets (which populate the engine's Cedar schema) before any
        policy that references a tool. This declarative ordering replaces the
        original deployer's delete-and-retry heal loop; whether it fully removes the
        transient CREATE_FAILED race is confirmed at deploy + integration time.
        """
        manifest = json.loads(MANIFEST_PATH.read_text())
        validation_mode = manifest.get("validationMode", "FAIL_ON_ANY_FINDINGS")
        target_list = list(self.targets.values())

        policies: list[agentcore.CfnPolicy] = []
        for entry in manifest["policies"]:
            base = entry["name"].replace("-", "_")  # name must be ^[A-Za-z][A-Za-z0-9_]*$
            cedar = (REPO_ROOT / entry["file"]).read_text()
            cedar = (
                cedar.replace("__GATEWAY_ARN__", self.gateway.attr_gateway_arn)
                .replace("__REGION__", self.region)
                .replace("__ACCOUNT__", self.account)
            )
            statements = _split_cedar_statements(cedar)
            for idx, stmt in enumerate(statements):
                name = base if len(statements) == 1 else f"{base}_{idx + 1}"
                policy = agentcore.CfnPolicy(
                    self,
                    name,
                    name=name,
                    policy_engine_id=self.policy_engine.attr_policy_engine_id,
                    definition=agentcore.CfnPolicy.PolicyDefinitionProperty(
                        cedar=agentcore.CfnPolicy.CedarPolicyProperty(statement=stmt),
                    ),
                    validation_mode=validation_mode,
                )
                for target in target_list:
                    policy.add_dependency(target)
                policies.append(policy)
        return policies

    # ------------------------------------------------------------------
    # 8. Discovery: SSM Parameter Store (source of truth) + CfnOutputs (Risk #3)
    # ------------------------------------------------------------------
    def _publish_discovery(self) -> None:
        """Publish non-secret discovery values to SSM + stack outputs.

        SSM Parameter Store is the source of truth that helper scripts read
        (replacing the hand-written, secret-bearing DEPLOY_STATE.json). The demo
        credential stays in Secrets Manager (Risk #2) and is referenced here only
        by ARN, never by value. Scripts fetch everything via:
            aws ssm get-parameters-by-path --path /enterprise-mcp-gateway --recursive
        """
        prefix = "/enterprise-mcp-gateway"
        params: dict[str, str] = {
            "gateway/url": self.gateway.attr_gateway_url,
            "gateway/id": self.gateway.attr_gateway_identifier,
            "gateway/arn": self.gateway.attr_gateway_arn,
            "policy-engine/id": self.policy_engine.attr_policy_engine_id,
            "policy-engine/arn": self.policy_engine.attr_policy_engine_arn,
            "cognito/pool-id": self.user_pool.user_pool_id,
            "cognito/client-id": self.user_pool_client.user_pool_client_id,
            "cognito/discovery-url": self.discovery_url,
            "targets/docs-api-id": self.targets["DocsAPI"].attr_target_id,
            "targets/database-api-id": self.targets["DatabaseAPI"].attr_target_id,
            "targets/ehr-api-id": self.targets["EhrAPI"].attr_target_id,
            "roles/gateway-exec-arn": self.gateway_role.role_arn,
            "lambda/request-interceptor-arn": self.functions["request_interceptor"].function_arn,
            "lambda/response-interceptor-arn": self.functions["response_interceptor"].function_arn,
            "lambda/docs-target-arn": self.functions["docs_target"].function_arn,
            "lambda/database-target-arn": self.functions["database_target"].function_arn,
            "lambda/ehr-target-arn": self.functions["ehr_target"].function_arn,
        }
        for suffix, value in params.items():
            # Construct id: PascalCase from the suffix path (e.g. gateway/url -> GatewayUrlParam).
            cid = "".join(part.capitalize() for part in suffix.replace("/", "-").split("-")) + "Param"
            ssm.StringParameter(
                self,
                cid,
                parameter_name=f"{prefix}/{suffix}",
                string_value=value,
            )

        # Curated CfnOutputs for `cdk deploy --outputs-file` convenience (no secrets).
        CfnOutput(self, "GatewayUrl", value=self.gateway.attr_gateway_url)
        CfnOutput(self, "DiscoveryUrl", value=self.discovery_url)
        CfnOutput(self, "UserPoolId", value=self.user_pool.user_pool_id)
        CfnOutput(self, "AppClientId", value=self.user_pool_client.user_pool_client_id)
        CfnOutput(self, "SsmParameterPrefix", value=prefix)

// Strands Decider tools: open to any authenticated OAuth user.
// Resource ARN is substituted at deploy time (token __GATEWAY_ARN__).
//
// The Decider returns a decision about caller-supplied text and reads no
// enterprise data itself, so it carries no data-access risk of its own. The
// model runs on an in-account SageMaker endpoint, so the state never leaves the
// account boundary. Egress still passes the RESPONSE interceptor + Guardrail.
//
// One single-action permit per tool (the engine rejects `action in [...]`).
// Only active when the DeciderAPI target is registered (deciderLambdaArn set).

permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"DeciderAPI___decider_choose",
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
);

permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"DeciderAPI___decider_yes_no",
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
);

permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"DeciderAPI___decider_score",
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
);

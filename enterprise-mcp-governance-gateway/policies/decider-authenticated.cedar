// Strands Decider tool: open to any authenticated OAuth user.
// Resource ARN is substituted at deploy time (token __GATEWAY_ARN__).
//
// The Decider returns a decision about caller-supplied text and reads no
// enterprise data itself, so it carries no data-access risk of its own. The
// target Lambda (owned by StrandsDeciderStack) calls a private SageMaker
// endpoint over PrivateLink, so the state stays inside the account.
// Egress still passes the RESPONSE interceptor + Guardrail.
//
// Only active when the DeciderAPI target is registered (deciderLambdaArn set).

permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"DeciderAPI___decide",
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
);

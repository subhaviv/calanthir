// EHR tools — restricted to clinical staff.
// Resource ARN is substituted at deploy time (token __GATEWAY_ARN__).
//
// Governance model (mirrors the verified sensitive-tool-restrict pattern): the
// gateway validates the Cognito ACCESS token; its claims become Cedar principal
// tags. These two tools carry clinical PHI, so each is permitted ONLY when the
// caller presents the "clinical-staff" group. Default-deny (the policy engine's
// defaultDecision) blocks everyone else — the ALLOW/DENY is a platform decision
// here, not an in-agent check.
//
// Each tool REQUIRES its own single-action permit (the engine rejects
// `action in [...]` set-membership for tool authorization).
//
// Claim note: Cognito surfaces group membership in the access token as the
// `cognito:groups` claim. If your pool instead exposes groups via a custom
// scope or a different claim, change the tag name below to that claim.

permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"EhrAPI___ehr_fhir_lookup",
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
)
when {
  principal.hasTag("cognito:groups") &&
  principal.getTag("cognito:groups") like "*\"clinical-staff\"*"
};

permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"EhrAPI___imaging_lookup",
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
)
when {
  principal.hasTag("cognito:groups") &&
  principal.getTag("cognito:groups") like "*\"clinical-staff\"*"
};

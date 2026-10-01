// Explicit synthetic network acceptance through the production persistent runtime.
// The reusable harness includes installed native shell tools, scoped inference and
// egress brokers, direct-network denial, cancellation and access revocation.
if (process.env.WME_RUN_CANDIDATE_EGRESS_ACCEPTANCE !== "1") {
  throw new Error("Explicit candidate egress acceptance is required");
}
process.env.WME_RUN_CONTAINER_ACCEPTANCE = "1";
await import("../runtime/container-acceptance.mjs");

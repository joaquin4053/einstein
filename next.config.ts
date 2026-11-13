import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@modelcontextprotocol/sdk"],
  // lib/kg/ontology.ts reads the ontology at runtime.
  outputFileTracingIncludes: { "/api/**/*": ["./ontology/einstein.ttl"] },
};

export default nextConfig;

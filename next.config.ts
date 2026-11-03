import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // These run on the Node side only. Bundling them confuses their own dynamic
  // requires and buys nothing.
  serverExternalPackages: ["pg", "unpdf", "@anthropic-ai/sdk"],
};

export default nextConfig;

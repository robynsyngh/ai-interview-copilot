/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@copilot/shared"],
  typedRoutes: true,
};

export default nextConfig;

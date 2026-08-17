import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship as TypeScript source, so Next must compile them itself.
  transpilePackages: ['@mini-crux/core'],
  typescript: {
    // Type errors fail the build. CI also runs `tsc --noEmit` separately, which catches
    // test files that `next build` never looks at.
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
}

export default nextConfig

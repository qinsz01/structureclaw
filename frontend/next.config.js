import path from 'node:path'

const __dirname = import.meta.dirname

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  turbopack: {
    // The browser shares pure policy limits and legacy-id migration with the backend.
    root: path.resolve(__dirname, '..'),
  },
}

// Only inject NEXT_PUBLIC_API_URL when explicitly set (dev mode).
// In installed-package mode the env var is absent → api-base.ts returns ''
// and the browser uses same-origin relative URLs.
if (process.env.NEXT_PUBLIC_API_URL) {
  nextConfig.env = { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL }
}

export default nextConfig

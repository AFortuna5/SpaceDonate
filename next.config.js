
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/auth/:path*',
        destination: '/api/auth/:path*'
      }
    ]
  }
}

module.exports = nextConfig

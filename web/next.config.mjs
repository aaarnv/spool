/** @type {import('next').NextConfig} */
const nextConfig = {
  // web/ is its own project; pin tracing root so the parent lockfile isn't picked up.
  outputFileTracingRoot: import.meta.dirname,
  async headers() {
    return [
      {
        // Embeds exist to be iframed anywhere. /l/* stays unrestricted (unfurls).
        source: "/embed/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
      {
        // The signed-in dashboard must never render inside a third-party frame.
        source: "/dashboard/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;

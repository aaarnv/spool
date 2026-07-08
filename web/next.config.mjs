/** @type {import('next').NextConfig} */
const nextConfig = {
  // web/ is its own project; pin tracing root so the parent lockfile isn't picked up.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;

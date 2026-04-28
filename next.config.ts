import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Dev only: lets you load the dev server from origins other than
  // localhost (e.g. 127.0.0.1, the LAN IP) so you can sanity-test the
  // public-deployment cross-origin path without standing up a second
  // Next process. Has no effect on `next build` / `next start`.
  allowedDevOrigins: ["127.0.0.1", "192.168.0.0/16", "10.0.0.0/8"],
  async rewrites() {
    return [
      {
        source: "/install",
        destination: "/install.sh",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/install.sh",
        headers: [
          { key: "Content-Type", value: "text/x-shellscript; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://192.168.0.136:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://192.168.0.136:3001",
    "http://localhost:8081",
    "http://127.0.0.1:8081",
    "http://localhost:19006",
    "http://127.0.0.1:19006",
  ],
};

export default nextConfig;

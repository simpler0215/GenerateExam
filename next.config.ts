import type { NextConfig } from "next";
import os from "node:os";

function firstNonEmptyEnv(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function detectLanIpv4Hosts(): string[] {
  const interfaces = os.networkInterfaces();
  const hosts: string[] = [];

  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.internal || entry.family !== "IPv4") {
        continue;
      }
      hosts.push(entry.address);
    }
  }

  return hosts;
}

const configuredAllowedDevOrigins =
  firstNonEmptyEnv(process.env.NEXT_ALLOWED_DEV_ORIGINS)
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0) ?? [];

const allowedDevOrigins = Array.from(
  new Set(["127.0.0.1", "localhost", ...detectLanIpv4Hosts(), ...configuredAllowedDevOrigins]),
);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins,
  env: {
    NEXT_PUBLIC_FIREBASE_API_KEY: firstNonEmptyEnv(
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      process.env.VITE_FIREBASE_API_KEY,
    ),
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: firstNonEmptyEnv(
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      process.env.VITE_FIREBASE_AUTH_DOMAIN,
    ),
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: firstNonEmptyEnv(
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      process.env.VITE_FIREBASE_PROJECT_ID,
    ),
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: firstNonEmptyEnv(
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      process.env.VITE_FIREBASE_STORAGE_BUCKET,
    ),
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: firstNonEmptyEnv(
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    ),
    NEXT_PUBLIC_FIREBASE_APP_ID: firstNonEmptyEnv(
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
      process.env.VITE_FIREBASE_APP_ID,
    ),
  },
};

export default nextConfig;

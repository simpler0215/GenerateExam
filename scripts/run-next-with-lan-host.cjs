#!/usr/bin/env node

const os = require("os");
const { spawn } = require("child_process");

function isPrivateIpv4(address) {
  if (!address) {
    return false;
  }
  if (address.startsWith("10.")) {
    return true;
  }
  if (address.startsWith("192.168.")) {
    return true;
  }
  const match = /^172\.(\d+)\./.exec(address);
  if (!match) {
    return false;
  }
  const second = Number(match[1]);
  return Number.isFinite(second) && second >= 16 && second <= 31;
}

function getLanIpv4() {
  const interfaces = os.networkInterfaces();
  const all = [];

  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.internal || entry.family !== "IPv4") {
        continue;
      }
      all.push(entry.address);
    }
  }

  if (all.length === 0) {
    return null;
  }
  const privateIp = all.find((ip) => isPrivateIpv4(ip));
  return privateIp ?? all[0];
}

function main() {
  const mode = process.argv[2] === "start" ? "start" : "dev";
  const extraArgs = process.argv.slice(3);
  const lanHost = process.env.NEXT_HOST?.trim() || getLanIpv4();
  const bindHost = process.env.NEXT_BIND_HOST?.trim() || "0.0.0.0";
  const port = process.env.PORT?.trim() || "3100";
  const nextBin = require.resolve("next/dist/bin/next");

  const args = [nextBin, mode, "--hostname", bindHost, "--port", port, ...extraArgs];
  console.log(`[next-host] bind=${bindHost} mode=${mode}`);
  console.log(`- Local:        http://localhost:${port}`);
  if (lanHost) {
    console.log(`- Network:      http://${lanHost}:${port}`);
  } else {
    console.log(`- Network:      http://${bindHost}:${port}`);
  }

  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();

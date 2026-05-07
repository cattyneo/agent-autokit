#!/usr/bin/env node
import { readSync } from "node:fs";
import { createForceUnlockConfirm, runCli } from "./index.js";

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  confirm: createForceUnlockConfirm(
    {
      isTTY: process.stdin.isTTY,
      readLineSync: () => readLineSyncFromStdin(),
    },
    process.stderr,
  ),
});

function readLineSyncFromStdin(): string {
  const chunks: string[] = [];
  const buffer = Buffer.alloc(1);
  for (;;) {
    const bytes = readSync(process.stdin.fd, buffer, 0, 1, null);
    if (bytes === 0 || buffer[0] === 10) {
      return chunks.join("");
    }
    chunks.push(buffer.toString("utf8", 0, bytes));
  }
}

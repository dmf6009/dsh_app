#!/usr/bin/env node
/**
 * Mock dsh CLI used by the desktop-profile adapter tests.
 *
 * Speaks just enough of the real CLI surface for the adapter:
 * - `--version`                       → prints a fake version, exits 0
 * - `--profile headless <task...>`    → streams a canned answer to stdout,
 *                                       then exits 0 (or fails when
 *                                       MOCK_DSH_MODE=fail, hanging when
 *                                       MOCK_DSH_DELAY_MS is set)
 */

import fs from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('mock-dsh 0.0.1');
  process.exit(0);
}

if (process.env.MOCK_DSH_MODE === 'echo-args') {
  // Diagnostic mode: print argv + the --patch overlay content so adapter
  // tests can pin exactly what the runtime was invoked with.
  const patchIndex = args.indexOf('--patch');
  const patch = patchIndex >= 0 ? fs.readFileSync(args[patchIndex + 1], 'utf8') : null;
  console.log(JSON.stringify({ args, patch }));
  process.exit(0);
}

// Expected invocation: --profile headless <message words...>
const message = args.slice(2).join(' ');

if (process.env.MOCK_DSH_MODE === 'fail') {
  console.error('MOCK failure: RATE_LIMIT 429 quota exceeded');
  process.exit(3);
}

process.stdout.write('回答前半句，');
const delay = Number(process.env.MOCK_DSH_DELAY_MS ?? 30);
setTimeout(() => {
  process.stdout.write(`后半句（任务：${message}）。`);
  process.exit(0);
}, delay);

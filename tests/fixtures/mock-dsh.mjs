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

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('mock-dsh 0.0.1');
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

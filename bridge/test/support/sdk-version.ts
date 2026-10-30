/**
 * The Agent SDK version the real-CLI suite (test/real-cli.integration.test.ts) was last run against.
 *
 * Almost every safety claim about the Claude CLI (which settings run commands, what a pin stops, how
 * an interrupt ends) was MEASURED against the CLI the SDK bundles, and the suite that measures it is
 * opt-in, so `npm test` reports green without it. This constant is the tripwire: a default-suite test
 * (test/claude-driver.test.ts) fails when the installed SDK differs, and its message says to run
 * `npm run test:real-cli` and only then update the number. The SDK is pinned to an exact version in
 * package.json for the same reason.
 */
export const REAL_CLI_VERIFIED_SDK = '0.3.314';

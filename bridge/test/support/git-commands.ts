/**
 * The git commands the bundled Claude Code CLI starts, as the real-CLI suite measured them (test/real-cli.integration.test.ts,
 * "G2/D25") and as the README states them. One reviewed list in a file both suites can import, so that `npm test` can hold the
 * README's sentence to it while only the opt-in suite can hold the list to the CLI: a list typed twice drifts, and a README
 * sentence that is compared with nothing is a claim nobody keeps.
 *
 * Changing either list is a decision. Run `npm run test:real-cli` first and read what the CLI now does, then change the
 * README's git bullet, the banner line and this file together.
 */

/**
 * What the CLI still runs with CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS set (measured on 2.1.314): all three read-only, an
 * index lookup for its own local settings file and the remote's name and URL. None hashes a working-tree file, so none applies
 * a filter. These are the arguments after the CLI's own `-c` hardening options, joined by single spaces.
 */
export const GIT_STILL_RUNS: readonly string[] = ['ls-files --error-unmatch -- :(icase).claude/settings.local.json', 'remote', 'remote get-url origin'];

/** The commands the switch stops, and the control run must show the CLI starting: they build the git context in the prompt. */
export const GIT_CONTEXT_COMMANDS: readonly string[] = ['status', 'log', 'config'];

/** How the README spells one of the commands above (the pathspec of the first one is not for a reader). */
export const readmeSpelling = (command: string): string => (command.startsWith('ls-files') ? 'ls-files --error-unmatch' : command);

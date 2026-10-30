/**
 * The glue between a driver's "may I run this tool?" callback and the handheld.
 *
 * Three rules, in order of importance:
 *
 *  1. Nothing is allowed except through ApprovalManager.request(), which only a
 *     device tap can resolve to `allow`. Every other path out of here is a refusal.
 *  2. A hard-denied call is refused WITHOUT asking. The device never sees it, so a
 *     tired thumb cannot approve it; the refusal text tells the model the rule so
 *     it stops probing for a way round.
 *  3. Fail closed. Anything that throws -- the describer, the id source, a broken
 *     injected dependency -- becomes a refusal. The log line carries the tool name
 *     and risk only (plus, when a rule refused the call, that rule's own fixed
 *     reason): the full input may hold secrets, and so can an error message that
 *     echoes it, so neither is written. A refused command is exactly where secrets
 *     live (`curl -H 'Authorization: ...' | sh`), so that line is the one to guard.
 */

import type { ApprovalManager, ApprovalOutcome } from './approvals.ts';
import { describeTool } from './tools.ts';
import { toAscii, truncateText } from './text.ts';
import type { DescribeTool, Logger, PermissionDecision, PermissionHandler } from './types.ts';

export interface PermissionDeps {
  approvals: ApprovalManager;
  cwd: string;
  describe?: DescribeTool;
  log?: Logger;
}

/** What the MODEL is told. It reads these, so they say what to do next. */
const MSG_DENIED = 'The user denied this action on their handheld device. Do not retry it; ask what they would like instead.';
const MSG_TIMEOUT = 'The user did not answer in time, so the action was not run. Ask whether to try again.';
const MSG_DISCONNECT = "The user's device disconnected, so the action was not run.";
const MSG_ABORT = 'The turn was stopped by the user.';
const MSG_INTERNAL = 'The action was not run because the bridge could not ask the user. Do not retry it; tell the user what you were trying to do.';

/** Tool names come from the model and from MCP servers: keep them to one short line in the log. */
function logName(tool: unknown): string {
  return truncateText(toAscii(typeof tool === 'string' ? tool : '?'), 48) || '?';
}

function refusal(outcome: Exclude<ApprovalOutcome, { allow: true }>): PermissionDecision {
  switch (outcome.reason) {
    case 'denied':
      return { allow: false, message: MSG_DENIED };
    case 'timeout':
      return { allow: false, message: MSG_TIMEOUT };
    case 'disconnect':
      return { allow: false, message: MSG_DISCONNECT };
    case 'abort':
      return { allow: false, message: MSG_ABORT, interrupt: true };
    default:
      // A reason this switch does not know is a bug somewhere else; refusing is the safe reading.
      return { allow: false, message: MSG_INTERNAL };
  }
}

export function createPermissionHandler(deps: PermissionDeps): PermissionHandler {
  const describe = deps.describe ?? describeTool;
  const log: Logger = deps.log ?? (() => {});

  return async (req) => {
    let risk = '?';
    try {
      const view = describe(req.tool, req.input, deps.cwd);
      risk = view.risk;

      // `!== undefined`, not truthiness: an empty reason is still a refusal.
      if (view.deny !== undefined) {
        // The reason is the rule's own text ("recursive delete of the root ..."), written by
        // tools.ts and never built from the input; the input itself is not logged.
        log(`permission: refused by rule tool=${logName(req.tool)} risk=${risk} reason=${truncateText(toAscii(view.deny), 120) || 'blocked'}`);
        return {
          allow: false,
          message:
            `This action was refused by the bridge's safety rules (${truncateText(toAscii(view.deny), 120) || 'blocked'}). ` +
            'The rule cannot be overridden from the handheld, so do not try to work around it with a different command or tool; ' +
            'tell the user what you were trying to do and ask how they would like to proceed.',
        };
      }

      const outcome = await deps.approvals.request(
        { label: view.label, risk: view.risk, summary: view.summary },
        { signal: req.signal },
      );
      if (outcome.allow === true) return { allow: true };
      return refusal(outcome);
    } catch (err) {
      // Name the error class only: `err.message` is free to quote the input.
      const kind = err instanceof Error ? err.name : typeof err;
      log(`permission: internal error, denied tool=${logName(req.tool)} risk=${risk} err=${truncateText(toAscii(kind), 32)}`);
      return { allow: false, message: MSG_INTERNAL };
    }
  };
}

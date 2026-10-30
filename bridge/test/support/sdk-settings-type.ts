/**
 * The Agent SDK's `Settings` type, read at test time with the TypeScript compiler.
 *
 * Why a test reads a TYPE. The driver pins settings keys in a file the CLI loads at the highest
 * priority, and a list of keys written by hand goes stale the day the SDK adds one (the type has
 * about 180 today). The SDK ships its types but no runtime schema, so the compiler API is the one
 * honest way to ask "which keys exist, and which of them run a command?" without restating the
 * answer in the test. It is also the only way to check a pin's SHAPE before the real CLI sees it:
 * the CLI silently discards the WHOLE pinned file if one key has the wrong type (measured), and
 * `Settings` is exactly the contract it validates against.
 *
 * Costs about a second and a half the first time; the program is built once per process.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const BRIDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SDK_DTS = join(BRIDGE_DIR, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.d.ts');

export interface SettingsKey {
  name: string;
  /** The type as the compiler prints it, shortened. */
  type: string;
  doc: string;
  /** Some nested property of the type is called `command`, `argv`, `args`, `executable` or `cmd`. */
  runsCommand: boolean;
}

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
};

let cached: { keys: SettingsKey[] } | undefined;

function hasCommandShape(checker: ts.TypeChecker, type: ts.Type, depth: number, seen: Set<ts.Type>): boolean {
  if (depth < 0 || seen.has(type)) return false;
  seen.add(type);
  if (type.isUnion()) return type.types.some((t) => hasCommandShape(checker, t, depth, seen));
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  for (const prop of checker.getPropertiesOfType(type)) {
    if (/^(command|argv|args|executable|cmd)$/.test(prop.getName())) return true;
    if (hasCommandShape(checker, checker.getTypeOfSymbol(prop), depth - 1, seen)) return true;
  }
  for (const info of checker.getIndexInfosOfType(type)) {
    if (hasCommandShape(checker, info.type, depth - 1, seen)) return true;
  }
  return false;
}

/** Every top-level key of the SDK's `Settings` interface. */
export function settingsKeys(): SettingsKey[] {
  if (cached !== undefined) return cached.keys;
  const program = ts.createProgram([SDK_DTS], OPTIONS);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(SDK_DTS);
  if (source === undefined) throw new Error(`could not read ${SDK_DTS}`);
  let decl: ts.InterfaceDeclaration | undefined;
  ts.forEachChild(source, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'Settings') decl = node;
  });
  if (decl === undefined) throw new Error('the SDK no longer declares an interface called Settings; this helper needs updating');
  const type = checker.getTypeAtLocation(decl);
  const keys: SettingsKey[] = checker.getPropertiesOfType(type).map((prop) => {
    const propType = checker.getTypeOfSymbol(prop);
    return {
      name: prop.getName(),
      type: checker.typeToString(propType).slice(0, 80),
      doc: ts.displayPartsToString(prop.getDocumentationComment(checker)),
      runsCommand: hasCommandShape(checker, propType, 4, new Set()),
    };
  });
  cached = { keys };
  return keys;
}

/**
 * Type-check `value` as a `Settings` literal and return the compiler's complaints (empty when it is
 * one). A value that fails here is a value the CLI would reject, and a rejected pin file loses
 * every pin in it.
 */
export function settingsTypeErrors(value: unknown): string[] {
  const virtual = join(BRIDGE_DIR, '__settings_literal_check__.ts');
  const text = `import type { Settings } from '@anthropic-ai/claude-agent-sdk';\nexport const literal: Settings = ${JSON.stringify(value)};\n`;
  const host = ts.createCompilerHost(OPTIONS);
  const realGet = host.getSourceFile.bind(host);
  const realExists = host.fileExists.bind(host);
  const realRead = host.readFile.bind(host);
  host.fileExists = (f) => f === virtual || realExists(f);
  host.readFile = (f) => (f === virtual ? text : realRead(f));
  host.getSourceFile = (f, lang, onError, shouldCreate) =>
    f === virtual ? ts.createSourceFile(f, text, lang, true) : realGet(f, lang, onError, shouldCreate);
  const program = ts.createProgram([virtual], OPTIONS, host);
  const file = program.getSourceFile(virtual);
  if (file === undefined) throw new Error('could not build the virtual source file');
  return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, ' '),
  );
}

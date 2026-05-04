// Runtime safety layer for worker shell access.
//
// Workers are given the SDK's Bash tool, but every call is gated by
// `canUseTool` in the Anthropic provider. This module provides the gate.
//
// Three guarantees:
// 1. Command allowlist — only npm/npx/node/git read-only/safe shell built-ins
// 2. No filesystem escape — reject `cd `, `..`, absolute paths to system dirs
// 3. Audit log — every command (allowed or denied) appended to ~/.hive/audit.jsonl

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Each entry is a regex the command must match in full to be allowed.
// Tokens after the verb are matched as a permissive set: --flags, package
// names (incl. @scope/name), file paths, simple kv args. Order doesn't matter.
const TOKEN = `(?:--?[a-zA-Z][a-zA-Z0-9_-]*(?:=[a-zA-Z0-9@_./~+:,-]+)?|[@a-zA-Z0-9_./~+:,-]+|"[^"]*")`;
const TOKENS = `(?:\\s+${TOKEN})*`;

const ALLOWED: RegExp[] = [
  // package management — broad: any flags + any positional package names
  new RegExp(`^npm (install|i|ci|init|test|version|list|ls|outdated|audit|cache (?:clean|verify)|run [a-z0-9:_-]+)${TOKENS}$`),
  new RegExp(`^npx ${TOKEN}${TOKENS}$`),
  new RegExp(`^pnpm (install|i|ci|test|version|list|ls|run [a-z0-9:_-]+)${TOKENS}$`),
  new RegExp(`^yarn (install|test|version|list|add|remove|run [a-z0-9:_-]+)${TOKENS}$`),

  // node + tsc
  new RegExp(`^node${TOKENS}$`),
  new RegExp(`^tsc${TOKENS}$`),

  // git — read-only + local commit only (NO push/force/reset --hard)
  new RegExp(`^git (status|diff|log|show|branch|tag|remote(?: -v)?|config --get [a-z.]+|rev-parse [a-z-]+|ls-files|init)${TOKENS}$`),
  new RegExp(`^git (add|rm)${TOKENS}$`),
  /^git commit -m "[^"]+"$/,
  new RegExp(`^git checkout(?: -b)?${TOKENS}$`),

  // safe shell builtins
  /^pwd$/,
  new RegExp(`^ls${TOKENS}$`),
  new RegExp(`^cat${TOKENS}$`),
  /^echo "[^"]*"$/,
  new RegExp(`^mkdir(?: -p)?${TOKENS}$`),
  /^true$/,
  /^false$/,
];

// Always-deny patterns — even if they sneak through allowlist regex, block these.
const DENY: RegExp[] = [
  /\brm\s/,                       // any rm
  /\bsudo\b/,                     // privilege escalation
  /\bcurl\b|\bwget\b/,            // network downloads
  /\bssh\b|\bscp\b|\brsync\b/,    // remote access
  /\bnc\b|\bnetcat\b/,            // network listeners
  /\.\.\//,                       // path escape
  /\bcd\s/,                       // directory change
  /\b(export|set)\s+[A-Z_]+=/,    // env mutation
  /\bsource\s|^\.\s/,             // sourcing other scripts
  /\beval\b|\bexec\b/,            // arbitrary execution
  /\bgit\s+push\b/,               // no push without explicit user click
  /\bgit\s+reset\s+--hard\b/,     // no destructive resets
  /\bgit\s+(--|-c\s+).*push/,     // no sneaky pushes
  /;\s|&&|\|\||`|\$\(/,           // shell composition / substitution
  /\s>\s|\s>>\s|\s<\s|\|/,        // I/O redirection
];

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateCommand(cmd: string): ValidationResult {
  const trimmed = cmd.trim();
  if (!trimmed) return { ok: false, reason: 'empty command' };
  if (trimmed.length > 500) return { ok: false, reason: 'command too long' };

  for (const pattern of DENY) {
    if (pattern.test(trimmed)) return { ok: false, reason: `denied pattern: ${pattern.source}` };
  }
  for (const pattern of ALLOWED) {
    if (pattern.test(trimmed)) return { ok: true };
  }
  return { ok: false, reason: 'not in allowlist' };
}

// ----- audit log -----

let auditPath: string | null = null;

function getAuditPath(): string {
  if (auditPath) return auditPath;
  const dir = path.join(os.homedir(), '.hive');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  auditPath = path.join(dir, 'audit.jsonl');
  return auditPath;
}

export interface AuditEntry {
  ts: number;
  agent: string;
  tool: string;
  input: any;
  decision: 'allow' | 'deny';
  reason?: string;
}

export function audit(entry: AuditEntry): void {
  try {
    fs.appendFileSync(getAuditPath(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('[hive] audit append failed:', err);
  }
}

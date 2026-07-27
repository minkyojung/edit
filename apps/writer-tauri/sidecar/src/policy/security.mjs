// ── Security lockdown ────────────────────────────────────────────
//
// "Close the exits": the agent may edit files locally (that's the
// product), but two things must never be possible even if untrusted
// captured content (a web page / transcript) carries a prompt
// injection — (1) sending data OUT to the network, and (2) reading
// the user's SECRETS. This is Anthropic's "containment of last
// resort": if credentials can't be reached and egress is blocked, a
// successful injection is harmless.
//
// Two overlapping layers, because they govern DIFFERENT surfaces (per the
// SDK, tool access is controlled by permission rules, while the sandbox
// confines subprocesses — sdk.d.ts: "Filesystem and network restrictions
// are configured via permission rules, not via these sandbox settings"):
//   • deny RULES (settings.permissions.deny) — evaluated BEFORE the
//     canUseTool gate (and win even under bypass). This is the ONLY thing
//     that stops the in-process file tools (`Read`, `Glob`) from reading
//     `~/.ssh/id_rsa`, and it hard-blocks the common network shells. It
//     also holds when the sandbox can't initialise. Zero dependency.
//   • OS SANDBOX (options.sandbox) — kernel-level (macOS Seatbelt),
//     confines the tool SUBPROCESSES (`Bash`, and `Grep`/ripgrep): blocks
//     their network egress and (via `filesystem.denyRead`) their reads of
//     the same secret paths — closing the shell leaks the deny rules
//     can't. `failIfUnavailable: false` so a sandbox that can't initialise
//     degrades to the permission-rule layer instead of breaking chat.

import { homedir } from 'node:os'

/** Home-relative secret locations the agent must never read or write.
 * `~`-relative so the same list feeds both the sandbox (absolute paths)
 * and the permission rules (SDK `~/…` grammar). */
const SECRET_HOME_RELATIVE = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.config/gcloud',
  '.kube',
  '.npmrc',
  // The app's own encrypted OAuth/token stores. Block ONLY the secret `.enc`
  // files, NOT the whole app-data folder — that folder also holds the vault's
  // external git repo (`git-repos/`, kept out of the synced vault), which the
  // agent MUST be able to read and run `git` against to undo its own edits
  // (undo-ai-change skill). The `.enc` files are AES-256-GCM encrypted at rest;
  // this deny is defense-in-depth on top of that. A NEW encrypted store added to
  // secure_storage MUST be listed here too, or it becomes readable to the agent.
  'Library/Application Support/com.minkyojung.octave/claude-oauth.enc',
  'Library/Application Support/com.minkyojung.octave/google-oauth.enc',
  'Library/Application Support/com.minkyojung.octave/github-oauth.enc',
]

/** Absolute secret locations for the OS sandbox's `filesystem.denyRead`.
 * That layer confines only the tool SUBPROCESSES (Bash, and Grep — which
 * shells out to ripgrep); it does NOT govern the in-process file tools. */
function secretPaths() {
  const home = homedir()
  return SECRET_HOME_RELATIVE.map((rel) => `${home}/${rel}`)
}

/** Permission deny rules for the secret locations. Per the Claude Code
 * docs, the built-in file tools use the PERMISSION system, not the sandbox
 * ("Read, Edit, and Write use the permission system directly rather than
 * running through the sandbox") — so the sandbox `denyRead` above does NOT
 * stop them; without these rules the `Read` tool reads `~/.ssh/id_rsa`
 * straight into context.
 *
 * `Read` + `Edit` are the two canonical rule families and cover the whole
 * surface: a `Read` deny is applied best-effort to every read tool (`Read`,
 * and `Grep`/`Glob`), and an `Edit` deny to every write tool (`Edit`,
 * `Write`, `MultiEdit`, `NotebookEdit`) — and both also catch the file
 * commands Claude Code recognises in Bash (`cat`/`head`/`sed`). Arbitrary
 * subprocess reads (a python script) are caught by the sandbox `denyRead`
 * instead. Rules follow the gitignore-style grammar: `~/`-relative, plus a
 * `/**` variant so both the directory and everything under it match. */
export function secretDenyRules() {
  const rules = []
  for (const rel of SECRET_HOME_RELATIVE) {
    for (const tool of ['Read', 'Edit']) {
      rules.push(`${tool}(~/${rel})`)
      rules.push(`${tool}(~/${rel}/**)`)
    }
  }
  return rules
}

/** Deny rules that hard-block network-egress shells before any gate. */
export function egressDenyRules() {
  return [
    'Bash(curl:*)',
    'Bash(wget:*)',
    'Bash(nc:*)',
    'Bash(ncat:*)',
    'Bash(telnet:*)',
    'Bash(scp:*)',
    'Bash(sftp:*)',
  ]
}

/** Deny the commands that dump the process environment, where the SDK-required
 * CLAUDE_CODE_OAUTH_TOKEN lives (the CLI must receive it via env; Bash children
 * inherit it). This is defense-in-depth, NOT a complete boundary: it stops the
 * literal `printenv CLAUDE_CODE_OAUTH_TOKEN` / `env` probe an injected note is
 * likely to use, but shell expansion (`echo $CLAUDE_CODE_OAUTH_TOKEN`) can't be
 * caught by a command-name rule. The real closure is the sandbox blocking
 * network egress (so a read token can't leave the machine) — see sandboxLockdown
 * / failIfUnavailable. `set`/`export` are intentionally omitted: prefix-denying
 * them would break legitimate `set -e` / `export FOO=…` usage for little gain. */
export function envDumpDenyRules() {
  return ['Bash(printenv:*)', 'Bash(env:*)']
}

/** OS-sandbox config: block outbound network from tool subprocesses and
 * deny reads of the secret locations.
 *
 * `gitDir` is the vault's repo, which lives OUTSIDE the vault
 * (appdata `git-repos/`, so a file-sync can't corrupt it). Reading it was
 * already allowed — that's why `git log` / `git show` worked — but the sandbox
 * confines WRITES to the workspace, and the repo isn't in it. So `git revert`
 * died on `.git/index.lock: Operation not permitted` and the undo-ai-change
 * skill could find the commit to undo and then not undo it.
 *
 * Only the git dir is named. The SDK types don't say whether an explicit
 * `allowWrite` ADDS to the default writable set or REPLACES it, which matters:
 * if it replaced, listing only this path would silently make the vault
 * unwritable. Measured rather than assumed — with `allowWrite: [gitDir]` alone,
 * a write inside the vault still succeeds, so it ADDS. Scenario 2 of
 * verify-sandbox-git-write.mjs keeps that pinned. */
export function sandboxLockdown({ gitDir } = {}) {
  return {
    enabled: true,
    // failIfUnavailable:false → a host where the sandbox can't initialise
    // degrades to a warning instead of breaking chat. The Claude Code docs
    // recommend `true` for a hard security gate; deferred until the
    // packaged build confirms Seatbelt initialises there. Safe to defer:
    // the permission deny rules (secret + egress) are sandbox-INDEPENDENT
    // and still apply, and the only untrusted-content shape (intake) has no
    // Bash at all — the residual (arbitrary-subprocess reads/egress with the
    // sandbox down) is reachable only from the trusted, user-driven chat.
    failIfUnavailable: false,
    // Ignore the model's `dangerouslyDisableSandbox` escape hatch — a
    // sandboxed command that fails must NOT silently retry unsandboxed.
    // ("the dangerouslyDisableSandbox parameter is completely ignored and
    // all commands must run sandboxed" — Claude Code sandbox docs.)
    allowUnsandboxedCommands: false,
    // No allowed domains → tool subprocesses get no network egress (the
    // proxy pre-allows nothing, so every new host is blocked in headless).
    // The SDK↔model API channel and server-side WebSearch/WebFetch run
    // OUTSIDE this sandbox, so live web research still works.
    network: { allowedDomains: [] },
    // OS-level backstop for the SUBPROCESS reads the permission rules can't
    // reach (a python/node script opening a file itself). The tool-level
    // block lives in secretDenyRules().
    filesystem: {
      denyRead: secretPaths(),
      // Scoped to the repo the agent is meant to be able to rewrite — NOT the
      // enclosing app-data folder, which also holds the encrypted token stores.
      ...(gitDir ? { allowWrite: [gitDir] } : {}),
    },
  }
}

#!/usr/bin/env node
/**
 * git-sync.mjs — keeps every Claude Code session in step with GitHub, on every machine and in the cloud.
 *
 *   session  (SessionStart)      fetch; fast-forward, or rebase a clean tree, onto the upstream; tell
 *                                Claude about unpushed commits, uncommitted changes and conflicts.
 *   prompt   (UserPromptSubmit)  the same before each message (at most once a minute); silent unless
 *                                something was pulled or could not be.
 *   stop     (Stop)              if work is left unpushed or uncommitted, send Claude back once to
 *                                check, commit and push it (unless the user said not to); on a side
 *                                branch, remind it once to merge into main and delete the branch.
 *
 * The owner's rule is "only main": session start lists leftover branches (merged ones to delete,
 * unmerged ones to finish or ask about). The hook itself never deletes anything.
 *   install                      copy this script to ~/.claude/hooks and register it in
 *                                ~/.claude/settings.json, so every repository on this machine gets it.
 *
 * It never discards work: it only fast-forwards, or rebases when the tree is clean, and a rebase that
 * conflicts is aborted and handed to Claude. It never commits or pushes by itself (secrets, unfinished
 * work, "don't push" instructions stay Claude's and the user's call).
 * Off switches: CLAUDE_GIT_SYNC=off (everywhere) or `git config claude.gitsync false` (one repository).
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = 2;
const MODE = process.argv[2] || "";
const SELF = fileURLToPath(import.meta.url);
const PROMPT_EVERY_MS = 60_000;
const LIST_MAX = 12;

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
  GIT_EDITOR: "true",
  GIT_MERGE_AUTOEDIT: "no",
};

let ROOT = process.cwd();

function git(args, { timeout = 15_000, cwd = ROOT } = {}) {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd, env: GIT_ENV, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  return {
    ok: r.status === 0,
    out: (r.stdout || "").replace(/\s+$/, ""),
    err: (r.stderr || "").trim(),
    timedOut: r.error?.code === "ETIMEDOUT",
  };
}

const lines = (text) => text.split("\n").filter(Boolean);
const firstLine = (text) => String(text || "").split("\n").find((line) => line.trim())?.trim() || "";
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const list = (items) =>
  items.length <= LIST_MAX ? items.join(", ") : `${items.slice(0, LIST_MAX).join(", ")} (+${items.length - LIST_MAX} more)`;

function emit(obj) {
  if (obj) fs.writeSync(1, JSON.stringify(obj));
}

function readInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const readState = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
const writeState = (file, value) => {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); } catch { /* best effort */ }
};

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** A user-level copy stands aside in a repository that runs its own copy, so the work happens once. */
function deferToProjectCopy() {
  if (inside(SELF, ROOT)) return false;
  const settings = readState(path.join(ROOT, ".claude", "settings.json")) || "";
  return fs.existsSync(path.join(ROOT, ".claude", "hooks", "git-sync.mjs")) && settings.includes("git-sync.mjs");
}

function takeLock(file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* exists */ }
  try { if (Date.now() - fs.statSync(file).mtimeMs > 120_000) fs.rmSync(file, { force: true }); } catch { /* none */ }
  try { fs.writeFileSync(file, String(process.pid), { flag: "wx" }); return true; } catch { return false; }
}

function operationInProgress(gitDir) {
  const marks = [["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]];
  return marks.find(([file]) => fs.existsSync(path.join(gitDir, file)))?.[1] || null;
}

function branchInfo() {
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]).out || null;
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD"]).out || null;
  const up = branch ? git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) : null;
  const upstream = up?.ok && up.out ? up.out : null;
  const remotes = lines(git(["remote"]).out);
  let remote = branch ? git(["config", `branch.${branch}.remote`]).out : "";
  if (!remote || remote === ".") remote = remotes.includes("origin") ? "origin" : remotes[0] || "";
  return { branch, head, upstream: remote ? upstream : null, remote: remote || null };
}

function defaultBranch(remote) {
  const r = git(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  if (r.ok && r.out) return r.out;
  for (const name of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${name}`]).ok) return `${remote}/${name}`;
  }
  return null;
}

/** Every branch but the default one, split into fully merged (to delete) and holding work not in it. */
function otherBranches(info, def) {
  const defName = def.slice(info.remote.length + 1);
  const defTip = git(["rev-parse", def]).out;
  const refs = [
    ...lines(git(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).out).filter((b) => b !== defName),
    // origin/HEAD shows up as "origin" or "origin/HEAD" depending on the git version.
    ...lines(git(["for-each-ref", "--format=%(refname:short)", `refs/remotes/${info.remote}`]).out)
      .filter((r) => r !== def && r !== info.remote && r !== `${info.remote}/HEAD`),
  ].slice(0, 40);
  const merged = [];
  const unmerged = [];
  for (const ref of refs) {
    const own = Number(git(["rev-list", "--count", `${def}..${ref}`]).out) || 0;
    if (own) unmerged.push(`${ref} (${plural(own, "commit")} not in ${defName})`);
    // A branch sitting exactly on the default tip has most likely just been created: leave it.
    else if (ref !== info.branch && git(["rev-parse", ref]).out !== defTip) merged.push(ref);
  }
  return { defName, merged, unmerged };
}

function counts(range) {
  const r = git(["rev-list", "--left-right", "--count", range]);
  if (!r.ok) return null;
  const [ahead, behind] = r.out.split(/\s+/).map(Number);
  return { ahead, behind };
}

const unpushedRange = (info) => (info.upstream ? [`${info.upstream}..HEAD`] : ["HEAD", "--not", "--remotes"]);
const unpushed = (info) => (info.head ? Number(git(["rev-list", "--count", ...unpushedRange(info)]).out) || 0 : 0);
const subjects = (range, max = 8) => lines(git(["log", "--format=%h %s", `-n${max}`, ...range]).out);

function dirtyEntries() {
  const r = git(["--no-optional-locks", "status", "--porcelain"]);
  if (!r.ok) return [];
  return lines(r.out).map((line) => {
    let file = line.slice(3);
    if (file.includes(" -> ")) file = file.split(" -> ").pop();
    return { code: line.slice(0, 2), file: file.replace(/^"|"$/g, "") };
  });
}

/** Changes when HEAD moves or a changed file is edited again, so a turn that touched nothing is told apart. */
function fingerprint(head, dirty) {
  const hash = crypto.createHash("sha1").update(head || "");
  for (const { code, file } of dirty) {
    let stamp = "";
    try { const s = fs.statSync(path.join(ROOT, file)); stamp = `${s.size}:${s.mtimeMs}`; } catch { /* deleted */ }
    hash.update(`\n${code}${file}${stamp}`);
  }
  return hash.digest("hex");
}

function pull(info, dirty) {
  const c = counts(`HEAD...${info.upstream}`);
  if (!c || c.behind === 0) return null;
  const incoming = subjects([`HEAD..${info.upstream}`]);
  let how = null;
  let problem = null;
  if (c.ahead === 0) {
    const r = git(["merge", "--ff-only", "--quiet", info.upstream], { timeout: 40_000 });
    if (r.ok) how = "fast-forward";
    else problem = dirty.length
      ? `${info.upstream} has ${plural(c.behind, "new commit")} touching files with uncommitted changes here, so nothing was pulled. Commit those changes (after checks), then git pull --rebase, keeping both sides' work.`
      : `fast-forward to ${info.upstream} failed: ${firstLine(r.err) || "timed out"}.`;
  } else if (dirty.length) {
    problem = `${info.branch} has ${plural(c.ahead, "local commit")} not on ${info.upstream}, ${info.upstream} has ${plural(c.behind, "new commit")}, and there are uncommitted changes, so nothing was rebased (to keep the uncommitted work safe). Commit the changes (after checks), then git pull --rebase, keeping both sides' work.`;
  } else if (git(["rev-list", "--merges", `${info.upstream}..HEAD`]).out) {
    problem = `the local commits not on ${info.upstream} include a merge commit, so they were not rebased automatically. Bring in ${info.upstream}'s ${plural(c.behind, "new commit")} yourself (git pull --rebase, or git merge), keeping both sides' work.`;
  } else {
    const r = git(["rebase", "--quiet", info.upstream], { timeout: 40_000 });
    if (r.ok) how = `rebased ${plural(c.ahead, "local commit")} on top`;
    else {
      const conflicted = lines(git(["diff", "--name-only", "--diff-filter=U"]).out);
      const aborted = git(["rebase", "--abort"]).ok;
      problem = `rebasing ${plural(c.ahead, "local commit")} onto ${plural(c.behind, "new commit")} from ${info.upstream} conflicted${conflicted.length ? ` in ${list(conflicted)}` : ""}. ${aborted ? "The rebase was aborted; nothing was lost." : "The rebase could not be aborted, so the repository is mid-rebase."} Resolve it with git pull --rebase, keeping both sides' work (never drop the other machine's changes).`;
    }
  }
  if (!how) return { behind: c.behind, problem };
  const files = lines(git(["diff", "--name-only", info.head, "HEAD"]).out);
  return { behind: c.behind, how, incoming, files };
}

function result(event, notes, shown) {
  const out = {};
  if (shown.length) out.systemMessage = shown.join(" · ");
  if (notes.length) out.hookSpecificOutput = { hookEventName: event, additionalContext: notes.join("\n\n") };
  return Object.keys(out).length ? out : null;
}

/** Keeps ~/.claude/hooks/git-sync.mjs current on every machine that opens a repository holding a newer copy. */
function refreshUserCopy() {
  const dest = path.join(os.homedir(), ".claude", "hooks", "git-sync.mjs");
  const theirs = Number(/const VERSION = (\d+)/.exec(readState(dest) || "")?.[1]);
  if (theirs && theirs < VERSION && inside(SELF, ROOT)) {
    try { fs.copyFileSync(SELF, dest); } catch { /* not ours to fix here */ }
  }
  return fs.existsSync(dest);
}

function syncTurn({ input, gitDir, state, sid }) {
  const isSession = MODE === "session";
  const event = isSession ? "SessionStart" : "UserPromptSubmit";
  const notes = [];
  const shown = [];
  const throttled = (!isSession || ["clear", "compact"].includes(input.source))
    && Date.now() - (Number(readState(state("last-sync"))) || 0) < PROMPT_EVERY_MS;
  let info = branchInfo();
  const saveTurn = () => writeState(state(`turn-${sid}`), fingerprint(branchInfo().head, dirtyEntries()));
  const once = (key) => {
    if (!isSession && readState(state("reported")) === key) return false;
    writeState(state("reported"), key);
    return true;
  };

  const op = operationInProgress(gitDir);
  if (op) {
    if (once(`op:${op}`)) {
      notes.push(`A git ${op} is in progress in ${ROOT} (left by an earlier session or machine?), so git auto-sync did nothing. Finish or abort it before other work, keeping both sides' changes.`);
      shown.push(`git: a ${op} is in progress`);
    }
    saveTurn();
    return result(event, notes, shown);
  }
  if (!info.branch) {
    if (isSession) notes.push("HEAD is detached (no branch checked out), so git auto-sync did nothing. Check out a branch before committing work.");
    saveTurn();
    return result(event, notes, shown);
  }
  if (!info.remote || throttled) {
    saveTurn();
    return result(event, notes, shown);
  }

  const fetched = git(["fetch", "--prune", "--quiet", info.remote], { timeout: 20_000 });
  const fetchError = fetched.ok ? null : fetched.timedOut ? "timed out" : firstLine(fetched.err) || "failed";
  writeState(state("last-sync"), String(Date.now()));
  info = branchInfo();
  const pulled = info.upstream ? pull(info, dirtyEntries()) : null;
  info = branchInfo();
  const dirty = dirtyEntries();

  if (fetchError && isSession) {
    notes.push(`git fetch from ${info.remote} failed (${fetchError}); what follows uses the last fetched state. Fetch again before pushing.`);
    shown.push(`git: could not reach ${info.remote} (${fetchError})`);
  }
  if (pulled?.how) {
    shown.push(`git: pulled ${plural(pulled.behind, "new commit")} from ${info.upstream}`);
    notes.push(`Git auto-sync pulled ${plural(pulled.behind, "new commit")} from ${info.upstream} (${pulled.how}) ${isSession ? "at session start" : "before this message"}:\n${pulled.incoming.map((s) => `  ${s}`).join("\n")}\nFiles changed: ${list(pulled.files)}. Re-read any of these before editing them.`);
  }
  if (pulled?.problem && once(`problem:${git(["rev-parse", info.upstream]).out}`)) {
    shown.push(`git: ${info.upstream} has new commits that could not be pulled automatically`);
    notes.push(`Git auto-sync could not bring in new commits: ${pulled.problem}`);
  }

  if (isSession) {
    const def = defaultBranch(info.remote);
    if (!info.upstream) {
      const behind = def ? counts(`HEAD...${def}`)?.behind : 0;
      notes.push(`Branch ${info.branch} has no upstream on ${info.remote}${behind ? ` and is ${plural(behind, "commit")} behind ${def}; bring those in (git rebase ${def}) before starting` : ""}. When the work is done, push it with git push -u ${info.remote} ${info.branch}.`);
    } else if (def && def !== info.upstream) {
      const behind = counts(`HEAD...${def}`)?.behind;
      if (behind) notes.push(`This is branch ${info.branch}, not ${def}; it is ${plural(behind, "commit")} behind ${def}.`);
    }
    const ahead = unpushed(info);
    if (ahead) {
      notes.push(`${plural(ahead, "commit")} on ${info.branch} ${ahead === 1 ? "is" : "are"} not on ${info.upstream || info.remote} yet:\n${subjects(unpushedRange(info)).map((s) => `  ${s}`).join("\n")}`);
      shown.push(`git: ${plural(ahead, "commit")} not pushed yet`);
    }
    if (dirty.length) {
      notes.push(`Uncommitted changes are in the working tree (maybe left by an earlier session): ${list(dirty.map((d) => d.file))}.`);
      shown.push(`git: ${plural(dirty.length, "uncommitted change")}`);
    }
    if (ahead || dirty.length) {
      notes.push("Unless the user says otherwise: check that work (build/type-check, no secrets such as .env files or keys), commit it, git pull --rebase, then git push. If it looks like someone's unfinished work, ask before committing.");
    }
    if (def) {
      const { defName, merged, unmerged } = otherBranches(info, def);
      notes.push(`Owner's standing rule (every machine, every repo): only ${defName} should exist. When the job on a branch is done, merge it into ${defName}, push ${defName}, delete the branch locally and on ${info.remote}, remove its worktree, and switch back to ${defName}, without asking. Never delete tags (archive/* stay forever).`);
      if (merged.length) {
        notes.push(`Branches already merged into ${def}: ${list(merged)}. Delete them now, locally (git branch -d) and on ${info.remote} (git push ${info.remote} --delete <name>).`);
        shown.push(`git: ${plural(merged.length, "merged branch", "merged branches")} to delete`);
      }
      if (unmerged.length) {
        notes.push(`Branches with work not in ${defName}: ${list(unmerged)}. If a branch's job is done, merge it into ${defName} and delete it. If it may be another session's work in progress, ask the owner before deleting it.`);
        shown.push(`git: ${plural(unmerged.length, "other branch", "other branches")} with unmerged work`);
      }
    }
    if (!shown.length) shown.push(`git: ${info.branch} is up to date with ${info.upstream || info.remote}`);
    if (!refreshUserCopy() && !process.env.CLAUDE_CODE_REMOTE && inside(SELF, ROOT) && !readState(state("hinted"))) {
      writeState(state("hinted"), String(Date.now()));
      notes.push("Git auto-sync runs for this repository only. Tell the user, in one line, that running `node .claude/hooks/git-sync.mjs install` once turns it on for every repository on this machine.");
    }
    cleanOldState(path.dirname(state("x")));
  }
  saveTurn();
  return result(event, notes, shown);
}

function stop({ gitDir, state, sid }) {
  if (operationInProgress(gitDir)) return null;
  const info = branchInfo();
  if (!info.branch || !info.remote) return null;
  const dirty = dirtyEntries();
  const ahead = unpushed(info);
  const def = defaultBranch(info.remote);
  const defName = def ? def.slice(info.remote.length + 1) : null;
  let branchLine = null;
  if (defName && info.branch !== defName && !fs.existsSync(state(`branch-nag-${sid}`))) {
    const own = Number(git(["rev-list", "--count", `${def}..HEAD`]).out) || 0;
    branchLine = own
      ? `- You are on branch ${info.branch} (${plural(own, "commit")} not in ${defName}). Owner's rule: when its job is done, merge it into ${defName}, push ${defName}, delete ${info.branch} locally and on ${info.remote}, and switch back to ${defName}.`
      : `- Branch ${info.branch} holds nothing that ${defName} lacks. Owner's rule: switch back to ${defName} and delete ${info.branch} locally and on ${info.remote}, unless its job has only just started.`;
  }
  const pending = ahead > 0 || dirty.length > 0;
  const workReminder = pending
    && (readState(state(`turn-${sid}`)) !== fingerprint(info.head, dirty) || !fs.existsSync(state(`nag-${sid}`)));
  if (!workReminder && !branchLine) return null;
  if (workReminder) writeState(state(`nag-${sid}`), String(Date.now()));
  if (branchLine) writeState(state(`branch-nag-${sid}`), String(Date.now()));

  const reason = [workReminder
    ? `Git auto-sync: work on ${info.branch} is not on ${info.upstream || info.remote} yet.`
    : "Git auto-sync:"];
  if (workReminder) {
    if (ahead) reason.push(`- ${plural(ahead, "commit")} not pushed: ${subjects(unpushedRange(info), 5).join("; ")}`);
    if (dirty.length) reason.push(`- Uncommitted changes: ${list(dirty.map((d) => d.file))}`);
    const behind = info.upstream ? counts(`HEAD...${info.upstream}`)?.behind : 0;
    if (behind) reason.push(`- ${info.upstream} has ${plural(behind, "new commit")}: git pull --rebase before pushing, keeping both sides' work.`);
  }
  if (branchLine) reason.push(branchLine);
  reason.push(workReminder
    ? `Check it (build/type-check, no secrets such as .env files or keys), commit only the files that belong to this work, git pull --rebase, then git push${info.upstream ? "" : ` -u ${info.remote} ${info.branch}`}. If the user said not to commit or push, or the work is unfinished, say that in one line and stop.`
    : "If the job on this branch is not done yet, say that in one line and stop.");
  return { decision: "block", reason: reason.join("\n") };
}

function cleanOldState(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^(turn|nag|branch-nag)-/.test(name)) continue;
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > 3 * 24 * 3600_000) fs.rmSync(file, { force: true });
    }
  } catch { /* nothing to clean */ }
}

function install() {
  const home = os.homedir();
  const dest = path.join(home, ".claude", "hooks", "git-sync.mjs");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (path.resolve(SELF) !== path.resolve(dest)) fs.copyFileSync(SELF, dest);
  const settingsPath = path.join(home, ".claude", "settings.json");
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8") || "{}");
    } catch (error) {
      console.error(`${settingsPath} is not valid JSON, so it was left alone: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }
  settings.hooks ??= {};
  const wanted = [
    ["SessionStart", "session", 90, "Syncing with GitHub…"],
    ["UserPromptSubmit", "prompt", 90, "Checking GitHub for new commits…"],
    ["Stop", "stop", 30, null],
  ];
  const added = [];
  for (const [event, mode, timeout, statusMessage] of wanted) {
    const groups = (settings.hooks[event] ??= []);
    if (groups.some((group) => (group.hooks || []).some((hook) => String(hook.command || "").includes("git-sync.mjs")))) continue;
    const hook = { type: "command", command: `node "$HOME/.claude/hooks/git-sync.mjs" ${mode}`, timeout };
    if (statusMessage) hook.statusMessage = statusMessage;
    groups.push({ hooks: [hook] });
    added.push(event);
  }
  if (added.length) {
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.before-git-sync`);
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  console.log(`git auto-sync: script at ${dest}; ${added.length ? `registered ${added.join(", ")} in` : "already registered in"} ${settingsPath}. New Claude Code sessions pick it up.`);
}

function main() {
  const input = readInput();
  if (MODE === "install") return install();
  if (!["session", "prompt", "stop"].includes(MODE)) return;
  if (/^(off|0|false|no)$/i.test(process.env.CLAUDE_GIT_SYNC || "")) return;
  if (MODE === "stop" && input.stop_hook_active) return;

  const top = git(["rev-parse", "--show-toplevel"], { cwd: input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd() });
  if (!top.ok || !top.out) return;
  ROOT = top.out;
  if (git(["config", "--bool", "claude.gitsync"]).out === "false" || deferToProjectCopy()) return;
  const gitDir = git(["rev-parse", "--absolute-git-dir"]).out;
  if (!gitDir) return;
  const state = (name) => path.join(gitDir, "claude-git-sync", name);
  const lock = state("lock");
  if (!takeLock(lock)) return;
  try {
    const ctx = { input, gitDir, state, sid: String(input.session_id || "none").replace(/[^\w-]/g, "_") };
    emit(MODE === "stop" ? stop(ctx) : syncTurn(ctx));
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch { /* gone */ }
  }
}

try {
  main();
} catch (error) {
  if (MODE === "session") emit({ systemMessage: `git auto-sync failed: ${firstLine(error?.message)}` });
}

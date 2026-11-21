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
 * The owner's rule is "only main" (owner, 2026-11-21: "always pull, merge and delete useless branches, on
 * both computers, without me remembering"). Branches whose every commit is already in main are deleted by
 * the hook itself: locally, their clean worktrees, and on GitHub when the repository belongs to the owner
 * (claude.gitsync.owner). Branches holding work are handed to Claude: worked on in the last 30 days → merge
 * into main after checks and delete; touched in the last 2 hours → left alone (maybe live work on the
 * other computer); older than 30 days → reported, left alone. Tags are never touched.
 *   install                      copy this script to ~/.claude/hooks, register it in ~/.claude/settings.json
 *                                (every repository on this machine), set pull.rebase / rebase.autoStash /
 *                                fetch.prune, and schedule `sweep` every 30 minutes. A repository holding
 *                                this script installs it by itself on a machine that does not have it.
 *   sweep                        no Claude needed: every repository under claude.gitsync.roots is fetched,
 *                                fast-forwarded (or rebased when clean) and cleaned of merged branches.
 *
 * It never discards work: it only fast-forwards, or rebases when the tree is clean, and a rebase that
 * conflicts is aborted and handed to Claude. It never deletes a branch holding a commit main lacks, and it
 * never commits or pushes work by itself (secrets, unfinished work, "don't push" stay Claude's and the
 * user's call).
 * Off switches: CLAUDE_GIT_SYNC=off (everywhere) or `git config claude.gitsync false` (one repository).
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = 3;
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

const HOUR = 3_600_000;
/** Touched this recently, a branch may be live work on the other computer: never merged or deleted. */
const FRESH_MS = 2 * HOUR;
/** Untouched this long, a branch with unmerged work is abandoned: reported, left alone. */
const OLD_MS = 30 * 24 * HOUR;

/** The owner's GitHub login(s): git config --global claude.gitsync.owner (set by install). */
function owners() {
  return git(["config", "--global", "--get-all", "claude.gitsync.owner"], { cwd: os.homedir() }).out
    .split(/[\n,]/).map((name) => name.trim().toLowerCase()).filter(Boolean);
}

/** GitHub owner of a remote's URL ("https://github.com/<owner>/<repo>", "git@github.com:<owner>/<repo>"). */
function remoteOwner(remote, cwd = ROOT) {
  return (/github\.com[:/]+([^/]+)\//i.exec(git(["remote", "get-url", remote], { cwd }).out)?.[1] || "").toLowerCase();
}

/** Branches are deleted on GitHub only in the owner's own repositories, never in a team's or a stranger's. */
const ownsRemote = (remote) => Boolean(remote) && owners().includes(remoteOwner(remote));

const tipAge = (ref) => Date.now() - (Number(git(["log", "-1", "--format=%ct", ref]).out) || 0) * 1000;

/** When a local branch last moved (its reflog), or its tip commit's age without one. */
function localAge(name) {
  const stamp = Number(/@\{(\d+)\}/.exec(git(["reflog", "show", "--date=unix", "--format=%gd", "-n", "1", `refs/heads/${name}`]).out)?.[1]);
  return stamp ? Date.now() - stamp * 1000 : tipAge(`refs/heads/${name}`);
}

const ago = (ms) => (ms < 2 * HOUR ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 48 * HOUR ? `${Math.round(ms / HOUR)} h` : `${Math.round(ms / (24 * HOUR))} days`);

function worktreesByBranch() {
  const map = new Map();
  let dir = null;
  for (const line of git(["worktree", "list", "--porcelain"]).out.split("\n")) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && dir) map.set(line.slice("branch refs/heads/".length), dir);
  }
  return map;
}

/**
 * Removes a clean worktree. A linked folder inside it (node_modules joined to the main checkout) is unlinked
 * first and never followed: `git worktree remove --force` through such a junction emptied the main
 * checkout's node_modules before. Never --force.
 */
function removeWorktree(dir) {
  const status = git(["--no-optional-locks", "status", "--porcelain"], { cwd: dir });
  if (!status.ok || status.out) return false;
  for (const name of ["node_modules", ".next", "vendor", ".venv"]) {
    const link = path.join(dir, name);
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) continue;
      if (process.platform === "win32") fs.rmdirSync(link); else fs.unlinkSync(link);
    } catch { /* no such link */ }
  }
  return git(["worktree", "remove", dir], { timeout: 60_000 }).ok;
}

/**
 * Deletes every branch whose commits are all in the default branch: locally (with its clean worktree) and,
 * in the owner's own repositories, on the remote (at most `remoteBudget` pushes per run). A branch exactly
 * on the default tip that moved in the last 2 hours has most likely just been created and is left alone.
 */
function cleanMergedBranches(info, def, remoteBudget) {
  const defName = def.slice(info.remote.length + 1);
  const defTip = git(["rev-parse", def]).out;
  const trees = worktreesByBranch();
  const deleted = [];
  const failed = [];
  for (const name of lines(git(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).out)) {
    if (name === defName || name === info.branch) continue;
    if (Number(git(["rev-list", "--count", `${def}..refs/heads/${name}`]).out) !== 0) continue;
    if (git(["rev-parse", `refs/heads/${name}`]).out === defTip && localAge(name) < FRESH_MS) continue;
    const tree = trees.get(name);
    if (tree && path.resolve(tree) === path.resolve(ROOT)) continue;
    if (tree && !removeWorktree(tree)) { failed.push(`${name} (its worktree ${tree} has uncommitted changes)`); continue; }
    if (git(["branch", "-D", name]).ok) deleted.push(name); else failed.push(name);
  }
  if (ownsRemote(info.remote)) {
    let pushes = 0;
    // origin/HEAD shows up as "origin" or "origin/HEAD" depending on the git version.
    for (const ref of lines(git(["for-each-ref", "--format=%(refname:short)", `refs/remotes/${info.remote}`]).out)) {
      if (ref === def || ref === info.remote || ref === `${info.remote}/HEAD` || ref === info.upstream) continue;
      if (Number(git(["rev-list", "--count", `${def}..${ref}`]).out) !== 0) continue;
      if (git(["rev-parse", ref]).out === defTip || tipAge(ref) < HOUR) continue;
      if (pushes >= remoteBudget) break;
      pushes += 1;
      const r = git(["push", "--quiet", info.remote, "--delete", ref.slice(info.remote.length + 1)], { timeout: 30_000 });
      if (r.ok) deleted.push(ref); else failed.push(`${ref} (${firstLine(r.err) || "push failed"})`);
    }
  }
  git(["worktree", "prune"]);
  return { defName, deleted, failed };
}

/** Branches holding commits the default branch lacks, by how recently they moved (remote ones: owner's repos only). */
function unmergedBranches(info, def) {
  const defName = def.slice(info.remote.length + 1);
  const found = new Map();
  const add = (ref, name, age) => {
    const own = Number(git(["rev-list", "--count", `${def}..${ref}`]).out) || 0;
    if (!own) return;
    const seen = found.get(name);
    if (!seen || age < seen.age) found.set(name, { label: `${name} (${plural(own, "commit")} not in ${defName}, last change ${ago(age)} ago)`, age });
  };
  for (const name of lines(git(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).out)) {
    if (name !== defName) add(`refs/heads/${name}`, name, localAge(name));
  }
  if (ownsRemote(info.remote)) {
    for (const ref of lines(git(["for-each-ref", "--format=%(refname:short)", `refs/remotes/${info.remote}`]).out)) {
      if (ref === def || ref === info.remote || ref === `${info.remote}/HEAD`) continue;
      add(ref, ref.slice(info.remote.length + 1), tipAge(ref));
    }
  }
  const all = [...found.values()];
  return {
    defName,
    fresh: all.filter((b) => b.age < FRESH_MS).map((b) => b.label),
    recent: all.filter((b) => b.age >= FRESH_MS && b.age < OLD_MS).map((b) => b.label),
    old: all.filter((b) => b.age >= OLD_MS).map((b) => b.label),
  };
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

/**
 * Every machine that opens a repository holding this script gets it for all its repositories: installed when
 * missing, upgraded when older (the owner works on two computers and forgets to set either up). Not in the
 * cloud, where the home folder does not last. Returns "turned on" / "updated", or null when nothing changed.
 */
function refreshUserCopy() {
  if (process.env.CLAUDE_CODE_REMOTE || !inside(SELF, ROOT)) return null;
  const dest = path.join(os.homedir(), ".claude", "hooks", "git-sync.mjs");
  const theirs = Number(/const VERSION = (\d+)/.exec(readState(dest) || "")?.[1]) || 0;
  if (theirs >= VERSION) return null;
  try {
    install({ quiet: true });
    return theirs ? "updated" : "turned on";
  } catch {
    return null;
  }
}

/** Folders the background sweep walks (git config --global claude.gitsync.root, set by install). */
function sweepRoots() {
  return lines(git(["config", "--global", "--get-all", "claude.gitsync.root"], { cwd: os.homedir() }).out).filter((dir) => fs.existsSync(dir));
}

/** Git repositories under `root`, never inside OneDrive (its sync fights git), node_modules or a worktree folder. */
function findRepositories(root, depth = 5, found = []) {
  if (depth < 0 || /onedrive/i.test(root)) return found;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
  if (entries.some((entry) => entry.name === ".git")) { found.push(root); return found; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || /^(node_modules|\.next|\.venv|vendor|dist|build|worktrees|\..+)$/.test(entry.name)) continue;
    findRepositories(path.join(root, entry.name), depth - 1, found);
  }
  return found;
}

/**
 * No Claude needed (scheduled every 30 minutes by install): each repository is fetched, brought up to date
 * the same safe way a session does it (fast-forward, or rebase of a clean tree), and cleaned of merged
 * branches. Problems are left in a log for the next session; nothing is ever discarded.
 */
function sweep() {
  if (/^(off|0|false|no)$/i.test(process.env.CLAUDE_GIT_SYNC || "")) return;
  const report = [`git auto-sync sweep ${new Date().toISOString()}`];
  for (const repo of sweepRoots().flatMap((root) => findRepositories(root))) {
    ROOT = repo;
    const gitDir = git(["rev-parse", "--absolute-git-dir"]).out;
    if (!gitDir || git(["config", "--bool", "claude.gitsync"]).out === "false") continue;
    const state = (name) => path.join(gitDir, "claude-git-sync", name);
    if (Date.now() - (Number(readState(state("last-sync"))) || 0) < 10 * 60_000) continue;
    if (!takeLock(state("lock"))) continue;
    try {
      if (operationInProgress(gitDir)) { report.push(`${repo}: a git operation is in progress, left alone`); continue; }
      let info = branchInfo();
      if (!info.branch || !info.remote) continue;
      const fetched = git(["fetch", "--prune", "--quiet", info.remote], { timeout: 30_000 });
      writeState(state("last-sync"), String(Date.now()));
      if (!fetched.ok) { report.push(`${repo}: fetch failed (${firstLine(fetched.err) || "timed out"})`); continue; }
      info = branchInfo();
      const pulled = info.upstream ? pull(info, dirtyEntries()) : null;
      if (pulled?.how) report.push(`${repo}: pulled ${plural(pulled.behind, "commit")} (${pulled.how})`);
      if (pulled?.problem) report.push(`${repo}: not pulled — ${pulled.problem}`);
      const def = defaultBranch(info.remote);
      if (!def) continue;
      const cleaned = cleanMergedBranches(branchInfo(), def, 20);
      if (cleaned.deleted.length) report.push(`${repo}: deleted merged ${list(cleaned.deleted)}`);
      if (cleaned.failed.length) report.push(`${repo}: could not delete ${list(cleaned.failed)}`);
    } catch (error) {
      report.push(`${repo}: ${firstLine(error?.message)}`);
    } finally {
      try { fs.rmSync(state("lock"), { force: true }); } catch { /* gone */ }
    }
  }
  const log = path.join(os.homedir(), ".claude", "git-sync-sweep.log");
  const previous = (readState(log) || "").split("\n").slice(-400).join("\n");
  writeState(log, `${previous}\n${report.join("\n")}\n`.replace(/^\n+/, ""));
  if (process.stdout.isTTY) console.log(report.join("\n"));
}

/** The sweep every 30 minutes, without a window: Task Scheduler on Windows, crontab elsewhere. */
function scheduleSweep(dest) {
  if (process.platform === "win32") {
    const vbs = path.join(path.dirname(dest), "git-sync-sweep.vbs");
    fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${dest}"" sweep", 0, False\r\n`);
    const r = spawnSync("schtasks", ["/Create", "/F", "/SC", "MINUTE", "/MO", "30", "/TN", "Claude git auto-sync", "/TR", `wscript.exe "${vbs}"`],
      { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    return r.status === 0 ? "every 30 minutes (Task Scheduler: Claude git auto-sync)" : `not scheduled (${firstLine(r.stderr || r.stdout)})`;
  }
  const current = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 10_000 });
  if (current.error) return "not scheduled (no crontab)";
  const kept = (current.stdout || "").split("\n").filter((line) => line && !line.includes("# claude-git-sync"));
  const line = `*/30 * * * * "${process.execPath}" "${dest}" sweep >/dev/null 2>&1 # claude-git-sync`;
  const written = spawnSync("crontab", ["-"], { input: `${[...kept, line].join("\n")}\n`, encoding: "utf8", timeout: 10_000 });
  return written.status === 0 ? "every 30 minutes (crontab)" : `not scheduled (${firstLine(written.stderr)})`;
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
      const cleaned = cleanMergedBranches(info, def, 3);
      const { defName, fresh, recent, old } = unmergedBranches(info, def);
      notes.push(`Owner's standing rule (every machine, every repo): only ${defName} should exist. When the job on a branch is done, merge it into ${defName}, push ${defName}, delete the branch locally and on ${info.remote}, remove its worktree, and switch back to ${defName}, without asking. Never delete tags (archive/* stay forever).`);
      if (cleaned.deleted.length) {
        notes.push(`Git auto-sync deleted branches already merged into ${def}: ${list(cleaned.deleted)}.`);
        shown.push(`git: deleted ${plural(cleaned.deleted.length, "merged branch", "merged branches")}`);
      }
      if (cleaned.failed.length) notes.push(`Merged branches that could not be deleted automatically: ${list(cleaned.failed)}. Delete them (keep any uncommitted work in a worktree: commit or ask first).`);
      if (recent.length) {
        notes.push(`Branches with work not in ${defName}, changed in the last 30 days: ${list(recent)}. Owner's rule: merge each into ${defName} now (git merge, resolving any conflict by keeping both sides' work), run the checks this repository asks for, push ${defName}, then delete the branch locally and on ${info.remote}. Skip one only if it is this session's own unfinished work.`);
        shown.push(`git: ${plural(recent.length, "branch", "branches")} to merge into ${defName}`);
      }
      if (fresh.length) notes.push(`Changed in the last 2 hours, maybe live work on the other computer: ${list(fresh)}. Leave them for now.`);
      if (old.length) notes.push(`Untouched for 30+ days, with work never merged: ${list(old)}. Leave them unless the owner asks.`);
    }
    if (!shown.length) shown.push(`git: ${info.branch} is up to date with ${info.upstream || info.remote}`);
    const installed = refreshUserCopy();
    if (installed) shown.push(`git: auto-sync ${installed} for every repository on this computer`);
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

/** Whose GitHub repositories may have branches deleted remotely: the gh login, else this repository's owner. */
function detectOwner() {
  const gh = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  const login = gh.status === 0 ? firstLine(gh.stdout) : "";
  return login || (inside(SELF, ROOT) ? remoteOwner("origin") : "");
}

/** Where repositories live on this machine (never OneDrive: its sync fights git). */
function defaultRoots(home) {
  const candidates = [...(process.platform === "win32" ? ["C:/Dev", "D:/Dev"] : []),
    ...["Dev", "dev", "code", "Code", "projects", "Projects", "repos", path.join("Documents", "GitHub"), path.join("source", "repos")].map((dir) => path.join(home, dir))];
  return candidates.filter((dir) => !/onedrive/i.test(dir) && fs.existsSync(dir));
}

function install({ quiet = false } = {}) {
  const say = (text) => { if (!quiet) console.log(text); };
  const home = os.homedir();
  const dest = path.join(home, ".claude", "hooks", "git-sync.mjs");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (path.resolve(SELF) !== path.resolve(dest)) fs.copyFileSync(SELF, dest);
  // Plain `git pull` (a terminal, VS Code's sync button) rebases instead of making merge commits, carries
  // uncommitted edits across, and forgets branches deleted on GitHub: fewer conflicts between the computers.
  // Only settings the user has not chosen are set.
  const globalGit = (args) => git(["config", "--global", ...args], { cwd: home });
  for (const [key, value] of [["pull.rebase", "true"], ["rebase.autoStash", "true"], ["fetch.prune", "true"], ["push.autoSetupRemote", "true"]]) {
    if (!globalGit(["--get", key]).out) globalGit([key, value]);
  }
  if (!owners().length) { const owner = detectOwner(); if (owner) globalGit(["claude.gitsync.owner", owner]); }
  if (!sweepRoots().length) for (const root of defaultRoots(home)) globalGit(["--add", "claude.gitsync.root", root.replace(/\\/g, "/")]);
  const scheduled = scheduleSweep(dest);
  say(`git auto-sync: owner ${owners().join(", ") || "(unknown: branches are not deleted on GitHub)"}; sweeps ${sweepRoots().join(", ") || "(no folder)"} ${scheduled}.`);
  const settingsPath = path.join(home, ".claude", "settings.json");
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8") || "{}");
    } catch (error) {
      if (quiet) throw error;
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
    // The absolute path: "$HOME" is not expanded by every shell a hook may run in on Windows.
    const hook = { type: "command", command: `node "${dest.split(path.sep).join("/")}" ${mode}`, timeout };
    if (statusMessage) hook.statusMessage = statusMessage;
    groups.push({ hooks: [hook] });
    added.push(event);
  }
  if (added.length) {
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.before-git-sync`);
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  say(`git auto-sync: script at ${dest}; ${added.length ? `registered ${added.join(", ")} in` : "already registered in"} ${settingsPath}. New Claude Code sessions pick it up.`);
}

function main() {
  if (MODE === "install") return install();
  if (MODE === "sweep") return sweep();
  const input = readInput();
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

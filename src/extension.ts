import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as G from "./git";
import * as GH from "./github";
import { RepoTree, RepoState } from "./tree";

let tree: RepoTree;
let statusItem: vscode.StatusBarItem;
let log: vscode.OutputChannel;
let busy = false;
let refreshTimer: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("GithubVS");
  tree = new RepoTree();
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "githubvs.quickPush";

  const cmd = (id: string, fn: (...args: any[]) => Promise<unknown> | unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, (...a) => run(fn, ...a)));

  context.subscriptions.push(
    log,
    statusItem,
    vscode.window.registerTreeDataProvider("githubvs.repo", tree)
  );

  cmd("githubvs.quickPush", quickPush);
  cmd("githubvs.publish", publish);
  cmd("githubvs.clone", clone);
  cmd("githubvs.pull", pull);
  cmd("githubvs.sync", sync);
  cmd("githubvs.switchBranch", switchBranch);
  cmd("githubvs.openOnGitHub", openOnGitHub);
  cmd("githubvs.openPullRequest", openPullRequest);
  cmd("githubvs.refresh", refresh);
  cmd("githubvs.openChange", openChange);
  cmd("githubvs.openCommit", openCommit);

  // Keep the sidebar fresh
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.window.onDidChangeActiveTextEditor(scheduleRefresh),
    vscode.window.onDidChangeWindowState((s) => s.focused && scheduleRefresh()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("githubvs") && scheduleRefresh())
  );

  if (!(await G.isGitInstalled())) {
    const pick = await vscode.window.showWarningMessage(
      "GithubVS needs Git installed to work.",
      "Download Git"
    );
    if (pick) vscode.env.openExternal(vscode.Uri.parse("https://git-scm.com/downloads"));
  }
  await refresh();
}

export function deactivate() {}

// ---------- helpers ----------

async function run(fn: (...args: any[]) => unknown, ...args: any[]) {
  try {
    await fn(...args);
  } catch (e) {
    const err = e as Error;
    log.appendLine(`[error] ${err.message}`);
    if (e instanceof G.GitError && e.stderr) log.appendLine(e.stderr);
    const pick = await vscode.window.showErrorMessage(friendly(err.message), "Show Log");
    if (pick) log.show();
  } finally {
    scheduleRefresh();
  }
}

function friendly(msg: string): string {
  if (/non-fast-forward|fetch first|rejected/i.test(msg))
    return "Push rejected: GitHub has changes you don't have. Run Sync (pull then push).";
  if (/Authentication failed|could not read Username|403/i.test(msg))
    return "GitHub sign-in failed. Try again and allow access when VS Code asks.";
  if (/name already exists/i.test(msg)) return "You already have a GitHub repo with that name.";
  if (/would be overwritten by checkout/i.test(msg))
    return "Can't switch branch: you have unsaved changes. Push or commit them first.";
  return msg;
}

function currentFolder(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  return (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
}

async function currentRoot(): Promise<string | undefined> {
  const folder = currentFolder();
  return folder ? G.repoRoot(folder.uri.fsPath) : undefined;
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch((e) => log.appendLine(String(e))), 700);
}

async function loadState(root: string): Promise<RepoState> {
  const [status, commits, remote] = await Promise.all([G.status(root), G.recentCommits(root), G.remoteUrl(root)]);
  return { root, status, commits, remote, github: G.parseGitHubRemote(remote) };
}

async function refresh() {
  const root = await currentRoot();
  await vscode.commands.executeCommand("setContext", "githubvs.isRepo", !!root);
  if (!root) {
    tree.update(undefined);
    statusItem.hide();
    return;
  }
  const state = await loadState(root);
  tree.update(state);

  const cfg = vscode.workspace.getConfiguration("githubvs");
  if (!cfg.get<boolean>("showStatusBar", true)) return statusItem.hide();
  const n = state.status.changes.length;
  const ahead = state.status.ahead;
  statusItem.text = `$(cloud-upload) Push${n ? ` (${n})` : ahead ? ` (${ahead}↑)` : ""}`;
  statusItem.tooltip = `GithubVS: save, commit and push ${state.github ? `to ${state.github.owner}/${state.github.repo}` : ""}\n${n} changed file(s), ${ahead} commit(s) waiting`;
  statusItem.show();
}

/** Auth git config for github.com https remotes. Falls back to the user's own git credentials. */
async function authFor(remote: string | undefined): Promise<Record<string, string>> {
  if (!remote || !/^https:\/\/github\.com\//i.test(remote)) return {};
  try {
    const s = await GH.getSession(true);
    return s ? GH.authConfig(s.accessToken) : {};
  } catch {
    return {};
  }
}

/** Make sure commits have an author. Uses the GitHub account if git isn't set up. */
async function ensureIdentity(root: string) {
  if (await G.hasIdentity(root)) return;
  const session = await GH.getSession(true);
  if (!session) throw new Error("Set your Git name and email first (git config --global user.name / user.email).");
  const user = await GH.getUser(session.accessToken);
  await G.git(root, ["config", "user.name", user.name || user.login]);
  await G.git(root, ["config", "user.email", GH.noreplyEmail(user)]);
  log.appendLine(`Set commit author for this repo to ${user.login}`);
}

function withProgress<T>(title: string, task: (report: (msg: string) => void) => Promise<T>): Promise<T> {
  if (busy) throw new Error("GithubVS is already working on something. Give it a second.");
  busy = true;
  return Promise.resolve(
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      (p) => task((message) => { log.appendLine(`${title}: ${message}`); p.report({ message }); })
    )
  ).finally(() => (busy = false));
}

async function hasCommits(root: string): Promise<boolean> {
  try {
    await G.git(root, ["rev-parse", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function commitAll(root: string, suggested?: string): Promise<boolean> {
  const st = await G.status(root);
  if (!st.changes.length) return false;

  const cfg = vscode.workspace.getConfiguration("githubvs");
  const fallback = suggested ?? cfg.get<string>("defaultCommitMessage", "Update");
  let message = fallback;
  if (cfg.get<boolean>("askForCommitMessage", true)) {
    const input = await vscode.window.showInputBox({
      title: `Commit ${st.changes.length} changed file${st.changes.length === 1 ? "" : "s"}`,
      prompt: "What did you change? (Enter to use the default)",
      placeHolder: fallback,
      ignoreFocusOut: true,
    });
    if (input === undefined) throw new Cancelled();
    message = input.trim() || fallback;
  }
  await ensureIdentity(root);
  await G.git(root, ["add", "-A"]);
  await G.git(root, ["commit", "-m", message]);
  return true;
}

class Cancelled extends Error {
  constructor() { super("Cancelled"); }
}

async function pushBranch(root: string, report: (m: string) => void) {
  const st = await G.status(root);
  const remote = await G.remoteUrl(root);
  const auth = await authFor(remote);
  const cfg = vscode.workspace.getConfiguration("githubvs");

  if (st.upstream && cfg.get<boolean>("pullBeforePush", true)) {
    report("Getting latest changes…");
    try {
      await G.git(root, ["pull", "--rebase", "--autostash"], auth);
    } catch (e) {
      await G.git(root, ["rebase", "--abort"]).catch(() => undefined);
      throw new Error(
        "Your changes conflict with changes on GitHub. Nothing was lost. Open Source Control, pull, and fix the conflicts by hand."
      );
    }
  }
  report("Pushing…");
  if (st.upstream) await G.git(root, ["push"], auth);
  else await G.git(root, ["push", "-u", "origin", st.branch], auth);
}

// ---------- commands ----------

async function quickPush() {
  await vscode.workspace.saveAll(false);
  const root = await currentRoot();
  if (!root) return publish();

  const remote = await G.remoteUrl(root);
  if (!remote) {
    const pick = await vscode.window.showInformationMessage(
      "This repo isn't connected to GitHub yet. Publish it?",
      "Publish to GitHub"
    );
    if (pick) await publish();
    return;
  }

  try {
    const committed = await commitAll(root);
    const st = await G.status(root);
    if (!committed && st.upstream && st.ahead === 0) {
      vscode.window.showInformationMessage("Nothing to push. Everything is already on GitHub. ✅");
      return;
    }
  } catch (e) {
    if (e instanceof Cancelled) return;
    throw e;
  }

  await withProgress("GithubVS", (report) => pushBranch(root, report));
  const state = await loadState(root);
  const pick = await vscode.window.showInformationMessage(
    `Pushed to ${state.github ? `${state.github.owner}/${state.github.repo}` : "remote"} (${state.status.branch}) ✅`,
    ...(state.github ? ["Open on GitHub"] : [])
  );
  if (pick) openOnGitHub();
}

async function publish() {
  const folder = currentFolder();
  if (!folder) {
    const pick = await vscode.window.showInformationMessage("Open a folder first.", "Open Folder");
    if (pick) vscode.commands.executeCommand("vscode.openFolder");
    return;
  }
  const dir = folder.uri.fsPath;
  await vscode.workspace.saveAll(false);

  let root = await G.repoRoot(dir);
  if (root && (await G.remoteUrl(root))) {
    const pick = await vscode.window.showInformationMessage(
      "This folder is already connected to a remote. Push to it instead?",
      "Quick Push"
    );
    if (pick) await quickPush();
    return;
  }

  const session = await GH.getSession(true);
  if (!session) return;

  const cfg = vscode.workspace.getConfiguration("githubvs");
  const suggestedName = path.basename(dir).replace(/[^A-Za-z0-9._-]+/g, "-");
  const name = await vscode.window.showInputBox({
    title: "Publish to GitHub (1/2)",
    prompt: "Repository name",
    value: suggestedName,
    ignoreFocusOut: true,
    validateInput: (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? undefined : "Use letters, numbers, - _ . only"),
  });
  if (!name) return;

  const privateDefault = cfg.get<boolean>("newRepoPrivate", false);
  const options = [
    { label: "$(globe) Public", description: "Anyone can see it", isPrivate: false },
    { label: "$(lock) Private", description: "Only you (and people you invite)", isPrivate: true },
  ];
  if (privateDefault) options.reverse();
  const vis = await vscode.window.showQuickPick(options, { title: "Publish to GitHub (2/2)", ignoreFocusOut: true });
  if (!vis) return;

  const repo = await withProgress("Publishing to GitHub", async (report) => {
    if (!root) {
      report("Setting up Git…");
      await G.git(dir, ["init"]);
      await G.git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      root = dir;
    }
    // Don't upload giant dependency folders by accident
    const gitignore = path.join(root, ".gitignore");
    if (!fs.existsSync(gitignore)) {
      const ignores = ["node_modules", ".venv", "__pycache__", "build", "dist", "out", ".DS_Store"].filter(
        (n) => n === ".DS_Store" || fs.existsSync(path.join(root!, n))
      );
      fs.writeFileSync(gitignore, ignores.map((n) => (n.startsWith(".") ? n : n + "/")).join("\n") + "\n");
    }
    if (!(await hasCommits(root)) && (await G.status(root)).changes.length === 0) {
      fs.writeFileSync(path.join(root, "README.md"), `# ${name}\n`);
    }

    report("Creating repo…");
    const repo = await GH.createRepo(session.accessToken, name, vis.isPrivate);
    await G.git(root, ["remote", "add", "origin", repo.clone_url]);

    report("Committing…");
    await ensureIdentity(root);
    if ((await G.status(root)).changes.length) {
      await G.git(root, ["add", "-A"]);
      await G.git(root, ["commit", "-m", (await hasCommits(root)) ? "Update" : "First commit"]);
    }

    report("Pushing…");
    const branch = (await G.status(root)).branch;
    await G.git(root, ["push", "-u", "origin", branch], GH.authConfig(session.accessToken));
    return repo;
  });

  const pick = await vscode.window.showInformationMessage(`Published ${repo.full_name} 🎉`, "Open on GitHub");
  if (pick) vscode.env.openExternal(vscode.Uri.parse(repo.html_url));
}

async function clone() {
  const session = await GH.getSession(true);
  if (!session) return;

  const repos = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Loading your repos…" },
    () => GH.listRepos(session.accessToken)
  );
  const pick = await vscode.window.showQuickPick(
    repos.map((r) => ({
      label: `${r.private ? "$(lock)" : "$(repo)"} ${r.full_name}`,
      description: r.description ?? "",
      detail: `Updated ${new Date(r.updated_at).toLocaleDateString()}`,
      repo: r,
    })),
    { title: "Clone a repo", placeHolder: "Type to search your repos", matchOnDescription: true, ignoreFocusOut: true }
  );
  if (!pick) return;

  const parent = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: "Clone Here",
    title: `Choose where to put ${pick.repo.name}`,
  });
  if (!parent?.[0]) return;
  const dest = path.join(parent[0].fsPath, pick.repo.name);
  if (fs.existsSync(dest)) throw new Error(`A folder named ${pick.repo.name} is already there.`);

  await withProgress(`Cloning ${pick.repo.full_name}`, async (report) => {
    report("Downloading…");
    await G.git(parent[0].fsPath, ["clone", pick.repo.clone_url, dest], GH.authConfig(session.accessToken));
  });

  const open = await vscode.window.showInformationMessage(
    `Cloned ${pick.repo.full_name}.`,
    "Open",
    "Open in New Window"
  );
  if (open) {
    vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dest), open === "Open in New Window");
  }
}

async function pull() {
  const root = await requireRoot();
  await withProgress("Pulling", async (report) => {
    report("Getting latest changes…");
    const auth = await authFor(await G.remoteUrl(root));
    try {
      await G.git(root, ["pull", "--rebase", "--autostash"], auth);
    } catch (e) {
      await G.git(root, ["rebase", "--abort"]).catch(() => undefined);
      throw e;
    }
  });
  vscode.window.showInformationMessage("Up to date with GitHub ✅");
}

async function sync() {
  await vscode.workspace.saveAll(false);
  const root = await requireRoot();
  try {
    await commitAll(root);
  } catch (e) {
    if (e instanceof Cancelled) return;
    throw e;
  }
  await withProgress("Syncing", async (report) => {
    const st = await G.status(root);
    const auth = await authFor(await G.remoteUrl(root));
    if (st.upstream) {
      report("Pulling…");
      try {
        await G.git(root, ["pull", "--rebase", "--autostash"], auth);
      } catch (e) {
        await G.git(root, ["rebase", "--abort"]).catch(() => undefined);
        throw new Error("Your changes conflict with changes on GitHub. Fix them in Source Control, then push.");
      }
      report("Pushing…");
      await G.git(root, ["push"], auth);
    } else {
      report("Pushing…");
      await G.git(root, ["push", "-u", "origin", st.branch], auth);
    }
  });
  vscode.window.showInformationMessage("Synced with GitHub ✅");
}

async function switchBranch() {
  const root = await requireRoot();
  const [list, st] = await Promise.all([G.branches(root), G.status(root)]);
  const NEW = "$(add) Create new branch…";
  const pick = await vscode.window.showQuickPick(
    [NEW, ...list.map((b) => (b === st.branch ? `$(check) ${b}` : b))],
    { title: `Current branch: ${st.branch}` }
  );
  if (!pick || pick.startsWith("$(check)")) return;

  if (pick === NEW) {
    const name = await vscode.window.showInputBox({
      title: "New branch",
      prompt: "Branch name (your current changes come with you)",
      validateInput: (v) => (/^[\w./-]+$/.test(v) && !v.includes("..") ? undefined : "Letters, numbers, - _ / . only"),
    });
    if (!name) return;
    await G.git(root, ["checkout", "-b", name]);
    vscode.window.showInformationMessage(`Now on new branch ${name}. Quick Push will publish it.`);
  } else {
    await G.git(root, ["checkout", pick]);
    vscode.window.showInformationMessage(`Switched to ${pick}`);
  }
}

async function openOnGitHub() {
  const root = await requireRoot();
  const state = await loadState(root);
  if (!state.github) {
    const pick = await vscode.window.showInformationMessage("This folder isn't on GitHub yet.", "Publish to GitHub");
    if (pick) await publish();
    return;
  }
  const { owner, repo } = state.github;
  const url = state.status.upstream
    ? `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(state.status.branch)}`
    : `https://github.com/${owner}/${repo}`;
  vscode.env.openExternal(vscode.Uri.parse(url));
}

async function openPullRequest() {
  const root = await requireRoot();
  const state = await loadState(root);
  if (!state.github) throw new Error("This folder isn't on GitHub yet. Publish it first.");
  if (!state.status.upstream || state.status.ahead || state.status.changes.length) {
    const pick = await vscode.window.showInformationMessage(
      "Push your branch first so the pull request has your latest work.",
      "Quick Push, then open",
      "Open anyway"
    );
    if (!pick) return;
    if (pick.startsWith("Quick")) await quickPush();
  }
  const { owner, repo } = state.github;
  vscode.env.openExternal(
    vscode.Uri.parse(`https://github.com/${owner}/${repo}/compare/${encodeURIComponent(state.status.branch)}?expand=1`)
  );
}

async function openChange(uri: vscode.Uri) {
  if (!fs.existsSync(uri.fsPath)) {
    vscode.window.showInformationMessage(`${path.basename(uri.fsPath)} was deleted. It will be removed on GitHub when you push.`);
    return;
  }
  await vscode.commands.executeCommand("vscode.open", uri);
}

async function openCommit(hash: string) {
  const root = await requireRoot();
  const state = await loadState(root);
  if (state.github) {
    vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${state.github.owner}/${state.github.repo}/commit/${hash}`));
  } else {
    const text = await G.git(root, ["show", "--stat", "--patch", hash]);
    const doc = await vscode.workspace.openTextDocument({ content: text, language: "diff" });
    vscode.window.showTextDocument(doc, { preview: true });
  }
}

async function requireRoot(): Promise<string> {
  const root = await currentRoot();
  if (!root) throw new Error("Open a folder that's a Git repo first (or use Publish to GitHub).");
  return root;
}

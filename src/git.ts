import { execFile } from "child_process";

export class GitError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

export interface FileChange {
  path: string;
  /** Two-letter porcelain code, e.g. " M", "??", "A " */
  code: string;
}

export interface RepoStatus {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: FileChange[];
}

export interface Commit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  when: string;
}

/** Runs git in a folder. Extra config (like an auth header) is passed through env so it never shows in the process list. */
export function git(cwd: string, args: string[], extraConfig: Record<string, string> = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const keys = Object.keys(extraConfig);
  if (keys.length) {
    env.GIT_CONFIG_COUNT = String(keys.length);
    keys.forEach((k, i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = extraConfig[k];
    });
  }
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message).trim().split("\n").filter(Boolean).pop() ?? err.message;
        reject(new GitError(msg, stderr));
      } else {
        resolve(stdout.toString());
      }
    });
  });
}

export async function isGitInstalled(): Promise<boolean> {
  try {
    await git(process.cwd(), ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function repoRoot(folder: string): Promise<string | undefined> {
  try {
    return (await git(folder, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return undefined;
  }
}

export async function status(root: string): Promise<RepoStatus> {
  const out = await git(root, ["status", "--porcelain=v1", "--branch", "-uall"]);
  const lines = out.split("\n").filter(Boolean);
  const result: RepoStatus = { branch: "main", ahead: 0, behind: 0, changes: [] };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const head = line.slice(3);
      // Examples: "main...origin/main [ahead 1, behind 2]", "No commits yet on main", "main"
      const noCommits = head.match(/^No commits yet on (.+)$/);
      if (noCommits) {
        result.branch = noCommits[1];
        continue;
      }
      const m = head.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
      if (m) {
        result.branch = m[1];
        result.upstream = m[2];
        const ahead = m[3]?.match(/ahead (\d+)/);
        const behind = m[3]?.match(/behind (\d+)/);
        result.ahead = ahead ? Number(ahead[1]) : 0;
        result.behind = behind ? Number(behind[1]) : 0;
      }
    } else {
      let path = line.slice(3);
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) path = path.slice(arrow + 4);
      result.changes.push({ code: line.slice(0, 2), path: path.replace(/^"(.*)"$/, "$1") });
    }
  }
  return result;
}

export async function recentCommits(root: string, count = 10): Promise<Commit[]> {
  try {
    const out = await git(root, ["log", `-${count}`, "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ar"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, short, subject, author, when] = l.split("\x1f");
        return { hash, short, subject, author, when };
      });
  } catch {
    return []; // no commits yet
  }
}

export async function remoteUrl(root: string, name = "origin"): Promise<string | undefined> {
  try {
    return (await git(root, ["remote", "get-url", name])).trim();
  } catch {
    return undefined;
  }
}

export async function branches(root: string): Promise<string[]> {
  const out = await git(root, ["branch", "--format=%(refname:short)"]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function hasIdentity(root: string): Promise<boolean> {
  try {
    await git(root, ["config", "user.name"]);
    await git(root, ["config", "user.email"]);
    return true;
  } catch {
    return false;
  }
}

/** Parses "owner/repo" out of any GitHub remote URL (https or ssh). */
export function parseGitHubRemote(url: string | undefined): { owner: string; repo: string } | undefined {
  if (!url) return undefined;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

export function describeChange(code: string): string {
  const c = code.trim()[0] ?? "?";
  switch (c) {
    case "?": return "New";
    case "A": return "Added";
    case "M": return "Modified";
    case "D": return "Deleted";
    case "R": return "Renamed";
    case "C": return "Copied";
    case "U": return "Conflict";
    default: return "Changed";
  }
}

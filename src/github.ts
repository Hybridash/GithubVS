import * as vscode from "vscode";

const API = "https://api.github.com";
const SCOPES = ["repo", "read:user", "user:email"];

export interface GitHubRepo {
  full_name: string;
  name: string;
  private: boolean;
  description: string | null;
  clone_url: string;
  html_url: string;
  default_branch: string;
  updated_at: string;
}

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
}

/** Uses VS Code's built-in GitHub sign-in (no tokens to copy/paste). */
export async function getSession(createIfNone = true): Promise<vscode.AuthenticationSession | undefined> {
  return vscode.authentication.getSession("github", SCOPES, { createIfNone });
}

async function request<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(API + path, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "GithubVS",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { message?: string; errors?: { message?: string }[] };
      detail = j.errors?.[0]?.message ?? j.message ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(`GitHub: ${detail} (${res.status})`);
  }
  return (await res.json()) as T;
}

export function getUser(token: string): Promise<GitHubUser> {
  return request<GitHubUser>(token, "/user");
}

export async function listRepos(token: string): Promise<GitHubRepo[]> {
  const all: GitHubRepo[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await request<GitHubRepo[]>(
      token,
      `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`
    );
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export function createRepo(token: string, name: string, isPrivate: boolean, description?: string): Promise<GitHubRepo> {
  return request<GitHubRepo>(token, "/user/repos", {
    method: "POST",
    body: { name, private: isPrivate, description: description || undefined, auto_init: false },
  });
}

/** Git config that makes https pushes/pulls to github.com use the VS Code sign-in. */
export function authConfig(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    "credential.helper": "",
    "http.https://github.com/.extraheader": `AUTHORIZATION: basic ${basic}`,
  };
}

export function noreplyEmail(user: GitHubUser): string {
  return `${user.id}+${user.login}@users.noreply.github.com`;
}

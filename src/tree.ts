import * as vscode from "vscode";
import * as path from "path";
import { Commit, RepoStatus, describeChange } from "./git";

export interface RepoState {
  root: string;
  status: RepoStatus;
  commits: Commit[];
  github?: { owner: string; repo: string };
  remote?: string;
}

type Node =
  | { kind: "info"; label: string; description?: string; icon: string; tooltip?: string; command?: vscode.Command }
  | { kind: "group"; id: "changes" | "commits"; label: string; icon: string; count: number }
  | { kind: "change"; file: string; code: string }
  | { kind: "commit"; commit: Commit };

export class RepoTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  state?: RepoState;

  update(state: RepoState | undefined) {
    this.state = state;
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    const s = this.state;
    if (!s) return [];
    if (!node) {
      const st = s.status;
      const sync =
        !st.upstream ? "not pushed yet" :
        st.ahead === 0 && st.behind === 0 ? "up to date" :
        [st.ahead ? `${st.ahead} to push` : "", st.behind ? `${st.behind} to pull` : ""].filter(Boolean).join(", ");

      const items: Node[] = [
        s.github
          ? {
              kind: "info",
              label: `${s.github.owner}/${s.github.repo}`,
              icon: "github",
              tooltip: "Open on GitHub",
              command: { command: "githubvs.openOnGitHub", title: "Open on GitHub" },
            }
          : {
              kind: "info",
              label: s.remote ? "Remote (not GitHub)" : "Not on GitHub yet",
              description: s.remote ? s.remote : "click to publish",
              icon: s.remote ? "remote" : "repo-push",
              command: s.remote ? undefined : { command: "githubvs.publish", title: "Publish" },
            },
        {
          kind: "info",
          label: st.branch,
          description: sync,
          icon: "git-branch",
          tooltip: "Switch or create branch",
          command: { command: "githubvs.switchBranch", title: "Switch branch" },
        },
        {
          kind: "info",
          label: st.changes.length || st.ahead ? "Push now" : "Nothing to push",
          description: st.changes.length ? `${st.changes.length} changed file${st.changes.length === 1 ? "" : "s"}` : undefined,
          icon: "cloud-upload",
          command: { command: "githubvs.quickPush", title: "Quick Push" },
        },
        { kind: "group", id: "changes", label: "Changes", icon: "diff", count: st.changes.length },
        { kind: "group", id: "commits", label: "Recent Commits", icon: "history", count: s.commits.length },
      ];
      return items;
    }
    if (node.kind === "group" && node.id === "changes") {
      return s.status.changes.map((c) => ({ kind: "change", file: c.path, code: c.code }));
    }
    if (node.kind === "group" && node.id === "commits") {
      return s.commits.map((c) => ({ kind: "commit", commit: c }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "info": {
        const item = new vscode.TreeItem(node.label);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.tooltip;
        item.command = node.command;
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(
          node.label,
          node.count ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
        );
        item.description = String(node.count);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
      case "change": {
        const uri = vscode.Uri.file(path.join(this.state!.root, node.file));
        const item = new vscode.TreeItem(uri);
        item.label = path.basename(node.file);
        const dir = path.dirname(node.file);
        item.description = `${describeChange(node.code)}${dir !== "." ? " · " + dir : ""}`;
        item.resourceUri = uri;
        item.command = { command: "githubvs.openChange", title: "Open", arguments: [uri] };
        return item;
      }
      case "commit": {
        const c = node.commit;
        const item = new vscode.TreeItem(c.subject);
        item.description = `${c.short} · ${c.when}`;
        item.tooltip = `${c.subject}\n${c.author}, ${c.when}\n${c.hash}`;
        item.iconPath = new vscode.ThemeIcon("git-commit");
        item.command = { command: "githubvs.openCommit", title: "View", arguments: [c.hash] };
        return item;
      }
    }
  }
}

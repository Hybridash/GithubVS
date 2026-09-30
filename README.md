# GithubVS

**Manage your GitHub repo from VS Code's sidebar and push with one click.** You don't need a terminal, git commands, or to copy and paste tokens.

![icon](media/icon.png)

## What it does

| Feature | How |
|---|---|
| **Quick Push** | Saves everything, commits, and pushes in one click. Use the **Push** button in the status bar, the ☁ icon in the sidebar, or `Ctrl+Alt+P` (`Cmd+Alt+P` on Mac) |
| **Publish to GitHub** | Turns any folder into a new GitHub repo (public or private) and uploads it. Adds a `.gitignore` for `node_modules` etc. automatically |
| **Clone** | Pick from a searchable list of your GitHub repos, choose a folder, and it opens |
| **Sync** | Pulls then pushes, for when GitHub has changes you don't have |
| **Branches** | Switch branches or make a new one |
| **Pull Requests** | Opens the "create pull request" page for your current branch |
| **Sidebar** | Shows your repo, branch, what's waiting to push or pull, changed files, and recent commits |

Sign-in uses **VS Code's built-in GitHub account**. The first time, VS Code asks you to allow it. That's it.

## Install

**From a release:**
1. Download `githubvs-x.x.x.vsix` from [Releases](../../releases).
2. In VS Code: Extensions panel → `···` menu (top right) → **Install from VSIX…** → pick the file.

**From source:**
```bash
npm install
npm run package      # makes githubvs-1.0.0.vsix
code --install-extension githubvs-1.0.0.vsix
```

You need [Git](https://git-scm.com/downloads) installed.

## How to use

1. Open a folder in VS Code.
2. Click the **GithubVS** icon in the left bar.
3. If the folder isn't on GitHub yet, click **Publish to GitHub**, pick a name, and choose public or private.
4. After that, whenever you want to upload changes, click **Push** in the bottom status bar, type what you changed (or just press Enter), and you're done.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `githubvs.askForCommitMessage` | `true` | Ask for a message on each push. Turn off to push instantly |
| `githubvs.defaultCommitMessage` | `Update` | Message used when you leave it blank |
| `githubvs.pullBeforePush` | `true` | Grab GitHub's changes first so pushes don't get rejected |
| `githubvs.showStatusBar` | `true` | Show the Push button at the bottom |
| `githubvs.newRepoPrivate` | `false` | Make new repos private by default |

## Safety

- If pulling hits a conflict, GithubVS cancels the pull so nothing is lost, and tells you to fix it in Source Control.
- It never force-pushes.
- Your GitHub token stays inside VS Code. It's passed to git through environment variables and is never written to disk or to your git config.

## Development

```bash
npm install
npm run watch     # then press F5 in VS Code to try it in a test window
```

## License

MIT

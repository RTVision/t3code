# Source control

T3 Code integrates with GitHub, GitLab, Gitea, Bitbucket, and Azure DevOps to clone and publish
repositories, create pull requests, and review changes.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

Install [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, then sign in:

```bash
gh auth login
```

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Set an access token in the server's environment:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or use an Atlassian account email and API token with read/write access to repositories and pull
requests, plus user read access (`read:user:bitbucket`):

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

The access token takes precedence if both are configured. Restart the server after changing these
variables.

### Gitea

Set your Gitea web address and an access token in the environment of the machine running the
T3 Code server:

```bash
export T3CODE_GITEA_BASE_URL="https://gitea.example.com"
export T3CODE_GITEA_TOKEN="your-access-token"
```

Use the web root, including a proxy subpath if your server uses one. The token needs user read
access for account discovery, repository access for pull requests, and issue access for ordinary
comments and labels. Grant write access to repositories and issues for review and lifecycle actions.
Restart the server after setting these variables, then choose **Settings → Source Control → Rescan**.

One Gitea server can be configured per T3 environment. HTTPS remotes must use that web root;
SSH remotes must use the same hostname. SSH aliases and a separate SSH hostname are not currently
recognized. Configure Git authentication separately for cloning, fetching, and pushing.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

## Clone or publish a project

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

For Azure DevOps, use the host website to view diffs or change comments. Bitbucket does not support
reopening a declined pull request.

Gitea supports PR tracking, comments, reviews, diffs, reviewer and label updates, merge methods,
branch updates, and close/reopen. Draft status is shown when Gitea reports it, but draft/ready
changes, auto-merge controls, reactions, comment editing, workflow approval, and revert PRs are
not currently available in T3. Use your Gitea website for those tasks.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket or Gitea,
  confirm the running server received the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

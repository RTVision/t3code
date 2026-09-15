# Source control

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, and Azure DevOps to clone and publish
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

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`tea`)](https://gitea.com/gitea/tea) 0.16 or later on your T3 Code server.
Sign in with `fj --host https://your-server auth add-token` or `tea login add`.
Repeat for each server you use, including Codeberg.

T3 Code prefers a matching `fj` login and falls back to `tea` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. The upstream Forgejo integration supports both server types; RTVision also exposes its
Gitea review integration for the configured tea server.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `tea` because
fj 0.6 does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `tea`
login when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
If you have multiple `tea` accounts on one server, select one with
`tea login default <login-name>`. Git push and clone also need Git credentials or an SSH key
for that server.

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

### RTVision Gitea review features

Install [tea 0.16 or later](https://gitea.com/gitea/tea/releases) on the machine running
T3 Code. Run `tea login add` as the same OS user that runs the T3 daemon, enter your Gitea
web address and personal access token, then select that login with
`tea login default <login-name>`. The daemon must find this version of `tea` on its `PATH` and use the same home/config
directory where the login was saved. Tea stores personal access tokens in its local config file.

Existing installations can reuse their `T3CODE_GITEA_TOKEN` when creating the tea login.
T3 no longer reads that environment variable; tea stores and supplies the credentials.
The token needs user read access for account discovery, repository access for pull requests,
and issue access for comments and labels. Grant write access to repositories and issues
for review and lifecycle actions.

Optionally keep the Gitea web root in the daemon environment to select a server explicitly.
It must match the tea login URL, including any reverse proxy subpath:

```bash
export T3CODE_GITEA_BASE_URL="https://gitea.example.com"
```

Without an explicit web root, T3 uses the default tea login, or the only saved login.
Restart the server after changing its configuration, then choose
**Settings → Source Control → Rescan**.

RTVision's additional review features use one Gitea server per T3 environment. HTTPS remotes
must use that web root. SSH remotes can use the same hostname, tea's saved SSH hostname,
or an explicitly configured alias:

```bash
export T3CODE_GITEA_SSH_HOSTS="git.example.com,work-forge"
```

Use SSH aliases as `git@work-forge:owner/repository.git` or
`ssh://git@work-forge/owner/repository.git`. Git authentication remains separate:
SSH remotes need the daemon's SSH key or agent; HTTPS remotes need a Git credential helper.
Tea can register its helper with `tea login helper setup`.

Gitea drafts use a title prefix. If your server uses custom work-in-progress prefixes, configure
`T3CODE_GITEA_DRAFT_PREFIXES` with the same comma-separated values and restart T3. T3 verifies
that draft/ready changes take effect. Auto-merge uses Gitea's own scheduler and can merge immediately
when the request already satisfies its requirements.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

## Clone or publish a project

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer.

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

Type `@` in a review comment or reply to suggest people from the pull request and repository
on GitHub, Gitea, and GitLab. Select a name with the arrow keys and Enter or Tab. The mention
is sent when you submit the comment or review.

In the Code tab, mark files as **Viewed** to save your progress to the connected host account.
Uncheck a file to review it again. Progress follows that account across devices, and the host
marks changed files as needing another look. This is available on GitHub and Gitea servers
that support viewed-file access, when viewing all commits.

Use **Whitespace** in the Code tab to hide indentation or spacing changes while reviewing a
pull request or a single commit. Choose **Show all changes** to restore them. Comparisons with
separate hunks may need to load both file revisions from the host.

When the host can confirm that one pull request targets another pull request's branch, its review
panel shows the dependency chain. Select a related pull request there to open its usual review
panel. T3 marks incomplete discovery instead of guessing whether a release branch or another
unrelated non-default branch is part of a stack.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

GitHub sharing is off by default. In Settings → Connections → GitHub sharing (Environments on mobile), choose
**Read PRs** or **Read and act** for each environment you trust to share GitHub access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader GitHub permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

GitHub review details, linked PR status, and permitted review actions can then use another
connected environment signed in to the same GitHub account. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers and mobile clients need a paired environment to use its GitHub CLI credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. An action with
an uncertain result is never automatically retried elsewhere. Listings, diffs, and checkout or
PR creation from Git actions continue to use the project's environment.

For Azure DevOps, use the host website to view diffs or change comments. Bitbucket does not support
reopening a declined pull request.

Gitea supports PR tracking, comments, reviews, diffs, reviewer and label updates, merge methods,
branch updates, close/reopen, draft/ready changes, auto-merge controls, comment editing, and
reactions. Workflow approval and revert PRs are available when your Gitea server advertises
support for them.

In a pull request's checks, expand **CI runs** to see GitHub Actions or Gitea Actions runs and
jobs for the current revision. You can open their details or rerun a completed run, its failed
jobs, or a selected job when your account has write access. A job rerun may also run dependent
jobs. Use **Refresh CI** to see subsequent progress. On mobile, open the thread's Git sheet and
expand **CI runs and checks**.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket or Gitea,
  confirm the running server received the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked pull requests** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically.
Agents can link their pull requests with the `link_pull_request` tool.

Use **Link this PR** in a branch-detected badge's tooltip to keep it with the thread. From a review
on the Pull Requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. On mobile, the Git overview lists linked reviews and their stacks; tap a review to open it.
Linking and unlinking are available in the web and desktop clients.

The **Linked pull requests** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

## GitHub stacks

The Pull Requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.

---
description: How to retrieve detailed PR review comments including inline code feedback
---

# Retrieving PR Review Comments

The standard `gh pr view <id> --comments` command often misses inline code review comments (comments made on specific lines of code). To get the full picture, use the GitHub API via the CLI.

## Steps

1.  **Check GitHub CLI Availability**:
    ```bash
    gh --version
    ```

2.  **Get Repo and PR Information**:
    Ensure you know the owner, repo name, and PR number.
    ```bash
    # Example: leonzdev/tsla-ble-dash-expo, PR #2
    gh pr list
    ```

3.  **Fetch Comments via API**:
    Use the `gh api` command to hit the `pulls/:number/comments` endpoint. This returns all review comments on the diff.
    ```bash
    # Replace owner, repo, and pr_number
    gh api repos/:owner/:repo/pulls/:pr_number/comments
    ```
    
    *Example:*
    ```bash
    gh api repos/leonzdev/tsla-ble-dash-expo/pulls/2/comments
    ```

    **Note**: This returns a JSON array. Look for the `body`, `path`, and `line` fields to understand the feedback context.

4.  **Fetch General Comments (Optional)**:
    For top-level conversation (not code specific), you can still use:
    ```bash
    gh pr view :pr_number --comments
    ```

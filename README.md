# Mach-Speed
Modular static analysis engine for deployment readiness

## Run it

    npm install
    npm start

Open http://localhost:3000, paste a GitHub repo, hit **Scan repo**.

## Optional: GitHub token (recommended)

Without a token, Mach-Speed can make **60 GitHub API requests per hour**.
With one, that rises to **5,000 per hour** — worth doing if you scan often.

**1. Create a token** (free, takes a minute):
- Go to https://github.com/settings/personal-access-tokens
- Click **Generate new token** (fine-grained)
- Give it a name, and under **Repository access** choose **Public Repositories (read-only)**
- No other permissions are needed. Copy the token.

**2. Add it as an environment variable named `GITHUB_TOKEN`:**

| Where | How |
|---|---|
| Railway | Your service → **Variables** → add `GITHUB_TOKEN` = your token |
| Replit | **Tools → Secrets** → add `GITHUB_TOKEN` = your token |
| Local terminal | `GITHUB_TOKEN=your_token_here npm start` |

**3. Restart the server.** That's it — every GitHub request is now authenticated.

If the token is wrong or expired, scans will fail with `GitHub API error: 401` —
just generate a fresh token and update the variable.

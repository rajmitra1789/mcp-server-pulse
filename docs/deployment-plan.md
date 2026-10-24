# Deployment Plan: Google Workspace MCP Server on Railway

How to deploy this server to [Railway](https://railway.app) from your own GitHub repo, with Google login supplied by an environment variable instead of a `tokens.json` file.

Related docs: [README.md](../README.md) · [architecture.md](./architecture.md)

> **Read §4 before you generate a public domain.** The HTTP transport requires a shared bearer token on every endpoint except `/health`.

---

## 0. What's already in the repo

These parts are already done. You don't need to change any code to deploy.

| Item | Where | Status |
|------|-------|--------|
| Dockerfile build (Node 22, `node dist/index.js`) | `Dockerfile` | Done |
| Railway config: Dockerfile builder, health check on `/health` | `railway.toml` | Done |
| Reads Railway's `PORT`, switches to HTTP, binds to `0.0.0.0` | `src/config/env.ts` | Done |
| `GET /health` endpoint | `src/http/routes.ts` | Done |
| Token store that reads from an env var (`GOOGLE_TOKENS_JSON`) | `src/auth/tokenStore/envTokenStore.ts` | Done |
| Helper that prints `tokens.json` as a single line | `npm run tokens:env` | Done |
| Remote smoke test | `scripts/verify-server.ts` | Done |
| Authentication on the HTTP endpoints | `src/http/auth.ts` | Done |

---

## 1. Transport, port, host, and health check

### Transport: `streamable-http`

Railway runs the container as a network service, so it can't use `stdio`. Use `streamable-http`.

### Port and host: Railway's `PORT` on `0.0.0.0`

Railway injects a `PORT` variable and sends traffic to that port on all interfaces. The config layer (`src/config/env.ts`) handles this already. **Whenever `PORT` is set**, it:

- forces the transport to `streamable-http`
- binds to host `0.0.0.0`
- listens on `PORT`

When `PORT` is present, the server **ignores** `MCP_TRANSPORT`, `MCP_HOST`, and `MCP_PORT`. That means:

- **Don't** set `PORT` yourself. Let Railway inject it.
- **Don't** set `MCP_PORT=${{PORT}}`. It has no effect and only causes confusion.
- Setting `MCP_TRANSPORT=streamable-http` is optional. It's harmless and documents your intent. The Dockerfile already sets it, along with `MCP_HOST=0.0.0.0`.

### Endpoints on the deployed server

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Returns `{"status":"ok"}`. Railway's health check uses this (`railway.toml` → `healthcheckPath = "/health"`). |
| `GET` | `/` | Returns service info as JSON. |
| `POST` | `/` | The MCP Streamable HTTP endpoint. Point MCP clients at the base URL. |
| `GET` | `/oauth/start`, `/oauth/callback` | Browser-based Google login. **Not recommended on Railway** (see §2.5 and §4). |

After a deploy, the startup logs should include:

```json
{"level":"info","message":"MCP server configuration loaded","transport":"streamable-http","host":"0.0.0.0","port":8080,"tokenStore":"env",...}
```

`tokenStore: "env"` confirms that `GOOGLE_TOKENS_JSON` was picked up. If it says `"file"`, the variable is missing or empty.

---

## 2. Getting the Google login onto Railway without `tokens.json`

### 2.1 How it works

At startup, `createTokenStore()` checks for `GOOGLE_TOKENS_JSON`. If it's set, the server uses `EnvTokenStore`, which reads tokens from that variable and never touches the disk. If it isn't set, the server falls back to the file at `GOOGLE_TOKEN_STORE_PATH`.

Railway's filesystem is wiped on every redeploy, so on Railway you should use the env var.

### 2.2 Exact value format

The value must be **valid JSON on a single line**, in one of these two shapes.

**Shape A (recommended).** This is the exact contents of `tokens.json`, because the local auth flow writes tokens under the `default` key:

```json
{"default":{"accessToken":"ya29....","refreshToken":"1//0g....","expiryDate":1761400000000}}
```

**Shape B.** A bare token object. The server automatically treats it as `default`:

```json
{"accessToken":"ya29....","refreshToken":"1//0g....","expiryDate":1761400000000}
```

Field rules:

| Field | Type | Notes |
|-------|------|-------|
| `accessToken` | string | It can be expired. The server refreshes it automatically. |
| `refreshToken` | string | **The one that matters.** It must be present, or the server can't stay logged in. |
| `expiryDate` | **number** | Unix time in **milliseconds**, not a string and not seconds. |

Formatting rules for the Railway variable:

- Don't wrap the value in quotes. Paste the raw `{...}`.
- Don't escape the inner quotes (`\"`).
- Keep it on one line. Pretty-printed JSON with line breaks is the most common way to break this.
- If the JSON is invalid, the server fails at startup with `Invalid GOOGLE_TOKENS_JSON: ...` in the deploy logs.

### 2.3 Generate the tokens locally (one time)

1. In your local `.env`, use the **same** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` that you'll put on Railway. A refresh token only works with the OAuth client that issued it.
2. Keep `GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback` locally. Make sure that URI is registered on the OAuth client in Google Cloud Console.
3. Run the local login:

   ```bash
   npm run auth -- --callback-server
   ```

   This writes `./tokens.json`, which is gitignored.

### 2.4 Set the Railway variable

Pick **one** of these options.

**Option 1: Dashboard (simplest)**

1. Run `npm run tokens:env` locally. It prints one line that starts with `GOOGLE_TOKENS_JSON=`.
   - That line contains your refresh token. Copy it straight into Railway. Don't paste it into chats, tickets, or screenshots.
2. In Railway, go to your service → **Variables** → **Raw Editor**, and paste the whole line.
   - If you use **New Variable** instead: name it `GOOGLE_TOKENS_JSON` and paste only the `{...}` part as the value.
3. Click **Deploy** to apply the staged change.

**Option 2: Railway CLI (the token never appears on screen)**

```bash
railway login
railway link            # pick your project and service
railway variables --set "GOOGLE_TOKENS_JSON=$(node -e 'process.stdout.write(JSON.stringify(require(\"./tokens.json\")))')"
```

The shell builds the minified JSON and passes it straight to Railway. If your CLI version uses a different subcommand, check `railway variables --help`.

### 2.5 Things to know

- **Refreshed access tokens live in memory only.** After each restart, the server refreshes again using the stored refresh token. This is expected.
- **The refresh token is long-lived but can be revoked.** If you revoke access, change your Google password, or the app is in **Testing** mode, it can stop working. Google expires refresh tokens for apps in Testing after **7 days**. For something always-on, publish the OAuth consent screen to **Production** (or use an **Internal** app on Google Workspace).
- **To rotate:** revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), run `npm run auth -- --callback-server` again locally, and replace `GOOGLE_TOKENS_JSON` in Railway.
- **Don't use `/oauth/start` on Railway.** With the env token store, a browser login through `/oauth/callback` saves tokens **only in memory**, so they're lost on the next restart. Both OAuth routes require the bearer token (see §4).

---

## 3. Railway variables

Set these under your service → **Variables**.

### Required

| Variable | Value | Notes |
|----------|-------|-------|
| `GOOGLE_CLIENT_ID` | `xxxx.apps.googleusercontent.com` | Must be the same client that issued your refresh token. |
| `GOOGLE_CLIENT_SECRET` | `GOCSPX-...` | Secret. |
| `GOOGLE_REDIRECT_URI` | `https://<your-app>.up.railway.app/oauth/callback` | Required at startup even though refresh doesn't use it. If you ever use `/oauth/start`, add this exact URI to the OAuth client's **Authorized redirect URIs**. That requires a **Web application** client. Otherwise you can reuse your localhost URI; it only needs to be non-empty. |
| `GOOGLE_TOKENS_JSON` | `{"default":{...}}` | Secret. See §2. |

### Recommended

| Variable | Value | Notes |
|----------|-------|-------|
| `LOG_LEVEL` | `info` | Never use `debug` in production. |
| `MCP_TRANSPORT` | `streamable-http` | Optional. It's already forced when `PORT` is set and already set in the Dockerfile. |

### Required for HTTP transport

| Variable | Value | Notes |
|----------|-------|-------|
| `MCP_AUTH_TOKEN` | A long random string, for example from `openssl rand -hex 32` | Secret. This is the shared secret clients must send. |

### Don't set

| Variable | Why |
|----------|-----|
| `PORT` | Railway injects it. |
| `MCP_PORT`, `MCP_HOST` | Ignored when `PORT` is set. |
| `GOOGLE_TOKEN_STORE_PATH` | Not used when `GOOGLE_TOKENS_JSON` is set. The Dockerfile default (`/data/tokens.json`) is harmless. |
| `NODE_ENV` | The Dockerfile already sets `production`, so `.env` isn't loaded in the container. |

You don't need a Railway Volume with this approach.

---

## 4. Authentication on the HTTP transport

### Current state: shared-secret authentication is enabled

The HTTP server requires `Authorization: Bearer <MCP_AUTH_TOKEN>` before routing every request except `/health`. This includes `/`, MCP requests, `/oauth/start`, and `/oauth/callback`.

Tokens are compared with `crypto.timingSafeEqual`. If `MCP_AUTH_TOKEN` is missing in HTTP mode, configuration fails and the server refuses to start.

Add `MCP_AUTH_TOKEN`, using a random string of at least 32 bytes, as a Railway secret. Configure your MCP client to send it:

   ```json
   {
     "mcpServers": {
       "google-workspace-remote": {
         "url": "https://<your-app>.up.railway.app",
         "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
       }
     }
   }
   ```

Stronger options for later include OAuth 2.1 per the MCP authorization spec, or keeping the service on Railway private networking only. For a single-user server, a shared secret is enough.

---

## 5. Push to your own GitHub repo

The clone currently points at someone else's repo:

```text
origin  https://github.com/saksham20189575/mcp-server-4
```

The branch is `main`. The history contains no `.env`, `tokens.json`, or `credential.json`, and all three are in `.gitignore`.

### Steps

1. **Create an empty private repo** on GitHub, for example `<you>/google-workspace-mcp`. Don't add a README, `.gitignore`, or license, so the first push doesn't conflict.
2. **Point the remote at your repo.** Keep the original as `upstream` so you can still pull its updates:

   ```bash
   git remote rename origin upstream
   git remote add origin https://github.com/<you>/google-workspace-mcp.git
   git remote -v
   ```

   Or, with the GitHub CLI, after the rename:

   ```bash
   gh repo create <you>/google-workspace-mcp --private --source=. --remote=origin
   ```

3. **Check that no secrets are staged**, then commit any pending changes (for example the modified `package-lock.json`):

   ```bash
   git status
   git ls-files | grep -E '(^|/)(\.env|tokens\.json|credential\.json)$'   # should print nothing
   git add package-lock.json
   git commit -m "Update lockfile"
   ```

4. **Push:**

   ```bash
   git push -u origin main
   ```

5. **In Railway:** **New Project** → **Deploy from GitHub repo** → pick **your** repo. If prompted, install the Railway GitHub app with access to that repo. Railway detects `railway.toml` and the `Dockerfile` automatically.
6. Add the variables from §3, then deploy.
7. **Settings → Networking → Generate Domain** to get `https://<your-app>.up.railway.app`. Do this only after reading §4.

After this, every push to `main` on your repo triggers a redeploy.

---

## 6. Testing the deployed URL

Set the URL once in your local shell:

```bash
export MCP_URL=https://<your-app>.up.railway.app
```

### 6.1 Health check

```bash
curl -i "$MCP_URL/health"
# HTTP/2 200 ... {"status":"ok"}
```

Railway's dashboard should also show the deployment as **Healthy**, because it uses the same path.

### 6.2 MCP handshake with curl (optional)

```bash
curl -s -X POST "$MCP_URL/" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

You should get back an `initialize` result with `serverInfo.name = "google-workspace-mcp-server"`. Without the authorization header you should get `401`.

### 6.3 Full check with `scripts/verify-server.ts`

When `MCP_URL` is set, the script runs against the remote server instead of starting a local one. It:

1. calls `GET $MCP_URL/health` and expects `{"status":"ok"}`
2. connects over Streamable HTTP and lists tools, expecting exactly `gmail_create_draft`, `gmail_send_email`, and `google_docs_append_content`
3. calls `gmail_create_draft` with a bad email address and expects an `INVALID_INPUT` error
4. **creates a real Gmail draft** in the account behind `GOOGLE_TOKENS_JSON`. It doesn't send anything. This step confirms that the Google login works on Railway.

Before running it, note two things:

- The draft's recipient defaults to a hardcoded address (`sarora12@gmail.com`). **Set `TEST_EMAIL_TO` to your own address.**
- The script loads your local `.env` through dotenv. Any `MCP_URL` or `TEST_EMAIL_TO` set in your shell takes precedence.

Run it:

```bash
npm install          # the script needs devDependencies (tsx, @modelcontextprotocol/client)
MCP_URL=https://<your-app>.up.railway.app \
TEST_EMAIL_TO=you@example.com \
npx tsx scripts/verify-server.ts
```

Expected output:

```text
✓ Health endpoint responds
Using HTTP transport: https://<your-app>.up.railway.app
Connecting to MCP server...
✓ Connected
Discovered tools:
  - gmail_create_draft
  - gmail_send_email
  - google_docs_append_content
✓ All 3 expected tools discovered
✓ Validation error handling works
✓ Gmail draft created (draftId: ..., status: ...)
✅ MCP server verification passed
```

Then open Gmail → **Drafts**, confirm the `[MCP Verify] ...` draft is there, and delete it.

Set `MCP_AUTH_TOKEN` locally before running the script against an HTTP server. The script sends it as the `Authorization` header; the `/health` request remains unauthenticated.

### 6.4 If a step fails

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Deploy crashes with `Missing required environment variable: ...` | A required variable from §3 isn't set | Add it and redeploy |
| Deploy crashes with `Invalid GOOGLE_TOKENS_JSON` | Not valid single-line JSON, wrapped in quotes, or escaped | Re-set it using §2.4 |
| Logs show `"tokenStore":"file"` | `GOOGLE_TOKENS_JSON` is missing or empty | Set it, then redeploy |
| Health check times out in Railway | App crashed at startup | Read the deploy logs; usually one of the two rows above |
| Draft step fails with `GOOGLE_AUTH_REQUIRED` | No tokens loaded | See the `"tokenStore":"file"` row above |
| Draft step fails with `GOOGLE_TOKEN_REFRESH_FAILED` | Refresh token revoked or expired (7-day limit in Testing), or `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` don't match the client that issued it | Log in again locally with the same client, then replace `GOOGLE_TOKENS_JSON` |
| Draft step fails with `INSUFFICIENT_SCOPE` | The token was issued before the Gmail and Docs scopes were added | Log in again locally (`npm run auth -- --callback-server`) |
| Draft step fails with a `403` from Google | The account isn't a test user on the consent screen | Add it under **OAuth consent screen → Test users** |
| `ECONNREFUSED` or `404` from Railway's edge | No public domain, or the wrong URL | Generate a domain; use the base URL with no path |

---

## 7. Checklist

**Before deploying**

- [ ] My own GitHub repo is `origin`; the original is `upstream` (§5)
- [ ] `git ls-files` shows no `.env`, `tokens.json`, or `credential.json`
- [ ] Local login done using the same OAuth client as production (§2.3)
- [ ] OAuth consent screen published to Production, or I accept the 7-day refresh limit
- [ ] `MCP_AUTH_TOKEN` generated for shared-secret auth (§4)

**Railway**

- [ ] Service deployed from my repo; Dockerfile builder detected
- [ ] `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and `GOOGLE_TOKENS_JSON` set
- [ ] `MCP_AUTH_TOKEN` set
- [ ] `PORT`, `MCP_PORT`, and `MCP_HOST` not set manually
- [ ] Logs show `transport: streamable-http`, `host: 0.0.0.0`, `tokenStore: env`

**After deploying**

- [ ] `curl $MCP_URL/health` returns `{"status":"ok"}`
- [ ] `verify-server.ts` passes with `TEST_EMAIL_TO` set to my address
- [ ] Test draft deleted from Gmail
- [ ] Requests without the bearer token get `401`

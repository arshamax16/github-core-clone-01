[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/arshamax16/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/arshamax16/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01

A GitHub-compatible git forge in one Node process with no dependencies: smart HTTP
clone and push (protocol v0 and v2), repositories/issues/pull requests over REST v3,
queries and mutations over GraphQL v4, and tools over MCP (2026-07-28 era).

Built for the [Build a GitHub-compatible git forge bounty on make.fun](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript
types on its own. There is nothing to install: the program imports `node:http`,
`node:crypto`, `node:zlib` and its own modules only.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in
`MAKEFUN_ENV_URL`.

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; never bind
   8080 (that is the env's port).
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`.
   The first register wins; a later one is answered `409`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with
   `{"done":false}` while the suite runs and `{"done":true}` once its export is
   written. Poll it with a short backoff; never hold a request open.
4. **Exit 0** when it does.

A failed register or poll is retried with a short exponential backoff. If
`MAKEFUN_ENV_URL` is unset the server runs standalone until SIGTERM (local testing).

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issues, pull requests, mutations, node, introspection, batched operations |
| `POST /mcp` | Model Context Protocol over streamable HTTP: server/discover, initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v0 + v2), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
(the same token is in your environment); `/healthz` takes none. A missing or wrong
token is refused with 401; a repository under another owner is 404, never 403.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the HTTP server, routing and auth.
- `store.ts`: the in-memory store (repositories, objects, refs, issues, pull requests).
- `gitcore.ts`: the git object model — SHA-1 ids, pack read/write, pkt-lines, walks, diffs, three-way merges.
- `gitproto.ts`: the smart-HTTP protocol (advertisements, ls-refs, fetch, receive-pack).
- `rest.ts`: the REST v3 surface.
- `graphql.ts`: a small GraphQL parser and executor.
- `mcp.ts`: the MCP endpoint and its six tools.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

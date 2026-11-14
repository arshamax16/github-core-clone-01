// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments, pull requests, files and merges. All state lives in the Store.

import { type Store, type Repo, type Issue, type Pull, VIEWER_LOGIN, userInfo } from './store.ts';
import { type FileChange, parseCommit } from './gitcore.ts';

export class RestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RestResult {
  status: number;
  /** null = no body (204). */
  body: unknown;
}

function fail(status: number, message: string): never {
  throw new RestError(status, message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------- serializers

export function repoJson(repo: Repo): Record<string, unknown> {
  const owner = userInfo(repo.owner);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: owner.login, id: owner.id, type: owner.type },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  const user = userInfo(issue.user);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
    user: { login: user.login, id: user.id, type: user.type },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    locked: false,
    assignee: null,
    milestone: null,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headUser = userInfo(repo.owner);
  const baseUser = userInfo(repo.owner);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.headRef,
      sha: store.headSha(repo, pull),
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: headUser.login, id: headUser.id },
    },
    base: {
      ref: pull.baseRef,
      sha: store.baseSha(repo, pull),
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: baseUser.login, id: baseUser.id },
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: store.pullMergeable(repo, pull),
    user: { login: headUser.login, id: headUser.id },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    draft: false,
    locked: false,
  };
}

function commentJson(c: { id: number; body: string; user: string; createdAt: string }): Record<string, unknown> {
  const user = userInfo(c.user);
  return { id: c.id, body: c.body, user: { login: user.login, id: user.id }, created_at: c.createdAt, updated_at: c.createdAt };
}

// ---------------------------------------------------------------- pagination

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

/** Slice `items` to the requested page; returns the page plus a Link header value (or ''). */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  host: string,
  path: string,
): { page: T[]; link: string } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (totalPages <= 1) return { page: [...slice], link: '' };
  const base = `http://${host}${path}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  return { page: [...slice], link: links.join(', ') };
}

// ---------------------------------------------------------------- helpers

function viewerRepo(store: Store, owner: string, name: string): Repo {
  if (owner !== VIEWER_LOGIN) fail(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) fail(404, 'Not Found');
  return repo;
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (m === null) return { name: line, email: '', date: new Date(0).toISOString() };
  const epoch = Number.parseInt(m[3] as string, 10) * 1000;
  return { name: m[1] as string, email: m[2] as string, date: new Date(epoch).toISOString() };
}

// ---------------------------------------------------------------- the dispatcher

export interface RestContext {
  store: Store;
  method: string;
  /** Decoded path segments after /api/v3 (e.g. ['repos','adaiversen','x','issues']). */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  host: string;
  /** The raw path (for Link headers). */
  path: string;
}

export function handleRest(ctx: RestContext): { result: RestResult; link?: string } {
  const { store, method, segments } = ctx;
  const seg = (i: number): string => segments[i] ?? '';

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') fail(405, 'Method Not Allowed');
    return {
      result: {
        status: 200,
        body: {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          user_repositories_url: '/api/v3/user/repos',
          meta_url: '/api/v3/meta',
        },
      },
    };
  }

  // GET /api/v3/meta
  if (seg(0) === 'meta' && segments.length === 1) {
    if (method !== 'GET') fail(405, 'Method Not Allowed');
    return { result: { status: 200, body: { installed_version: '1.0.0' } } };
  }

  // GET /api/v3/user
  if (seg(0) === 'user' && segments.length === 1) {
    if (method !== 'GET') fail(405, 'Method Not Allowed');
    const u = userInfo(VIEWER_LOGIN);
    return {
      result: {
        status: 200,
        body: { login: u.login, id: u.id, name: u.name, email: u.email, type: u.type, html_url: `https://github.com/${u.login}` },
      },
    };
  }

  // /api/v3/user/repos
  if (seg(0) === 'user' && seg(1) === 'repos') {
    if (segments.length !== 2) fail(404, 'Not Found');
    if (method === 'GET') {
      const repos = store.reposOf(VIEWER_LOGIN);
      const { page, link } = paginate(repos.map(repoJson), ctx.query, ctx.host, ctx.path);
      return { result: { status: 200, body: page }, link };
    }
    if (method === 'POST') {
      if (!isRecord(ctx.body)) fail(400, 'Invalid request body');
      const name = reqString(ctx.body, 'name');
      if (name === '') fail(422, 'name is required');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) fail(422, 'Repository already exists');
      const isPrivate = ctx.body.private === true;
      const description = reqString(ctx.body, 'description');
      const repo = store.createRepo(VIEWER_LOGIN, name, isPrivate, description);
      return { result: { status: 201, body: repoJson(repo) } };
    }
    fail(405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg(0) === 'repos' && segments.length >= 3) {
    return handleRepoRoute(ctx, seg(1), seg(2), segments.slice(3));
  }

  fail(404, 'Not Found');
}

function handleRepoRoute(ctx: RestContext, owner: string, name: string, rest: string[]): { result: RestResult; link?: string } {
  const { store, method } = ctx;
  const repo = viewerRepo(store, owner, name);

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') return { result: { status: 200, body: repoJson(repo) } };
    if (method === 'PATCH') {
      if (!isRecord(ctx.body)) fail(400, 'Invalid request body');
      if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
      repo.updatedAt = new Date().toISOString();
      return { result: { status: 200, body: repoJson(repo) } };
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { result: { status: 204, body: null } };
    }
    fail(405, 'Method Not Allowed');
  }

  const head = rest[0] as string;

  // ---- branches
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') fail(405, 'Method Not Allowed');
      const list = store.branchNames(repo).map((b) => ({
        name: b,
        commit: { sha: store.branchTip(repo, b) as string },
        protected: false,
      }));
      return { result: { status: 200, body: list } };
    }
    if (rest.length === 2) {
      if (method !== 'GET') fail(405, 'Method Not Allowed');
      const branch = rest[1] as string;
      const tip = store.branchTip(repo, branch);
      if (tip === undefined) fail(404, 'Not Found');
      return { result: { status: 200, body: { name: branch, commit: { sha: tip }, protected: false } } };
    }
    fail(404, 'Not Found');
  }

  // ---- commits
  if (head === 'commits') {
    if (method !== 'GET') fail(405, 'Method Not Allowed');
    const shaParam = ctx.query.get('sha');
    let tip: string | undefined;
    if (shaParam === null || shaParam === '') tip = store.branchTip(repo, repo.defaultBranch);
    else if (/^[0-9a-f]{40}$/i.test(shaParam)) tip = shaParam;
    else tip = store.branchTip(repo, shaParam);
    if (tip === undefined) fail(404, 'Not Found');
    // History from the requested tip (first-parent walk, newest first).
    const get = store.objectGetter(repo);
    const history: string[] = [];
    {
      let cur: string | undefined = tip;
      const seen = new Set<string>();
      while (cur !== undefined && cur !== '0000000000000000000000000000000000000000' && !seen.has(cur)) {
        seen.add(cur);
        const obj = get(cur);
        if (obj === undefined || obj.type !== 'commit') break;
        history.push(cur);
        cur = parseCommit(obj.data).parents[0];
      }
    }
    const items = history.map((oid) => {
      const c = store.commitOf(repo, oid);
      if (c === null) return null;
      const obj = store.getObject(repo, oid);
      const raw = obj !== undefined ? obj.data.toString('utf8') : '';
      const authorLine = /^author (.*)$/m.exec(raw)?.[1] ?? '';
      const committerLine = /^committer (.*)$/m.exec(raw)?.[1] ?? '';
      const author = parseIdent(authorLine);
      const committer = parseIdent(committerLine);
      return {
        sha: oid,
        commit: {
          message: c.message,
          author: { name: author.name, email: author.email, date: author.date },
          committer: { name: committer.name, email: committer.email, date: committer.date },
        },
        parents: c.parents.map((p) => ({ sha: p })),
      };
    });
    const { page, link } = paginate(items.filter((x): x is NonNullable<typeof x> => x !== null), ctx.query, ctx.host, ctx.path);
    return { result: { status: 200, body: page }, link };
  }

  // ---- git refs
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (!isRecord(ctx.body)) fail(400, 'Invalid request body');
      const ref = reqString(ctx.body, 'ref');
      const sha = reqString(ctx.body, 'sha');
      if (!/^refs\/(heads|tags)\/.+/.test(ref)) fail(422, 'Invalid ref');
      if (!/^[0-9a-f]{40}$/i.test(sha)) fail(422, 'Invalid sha');
      if (store.getObject(repo, sha) === undefined) fail(422, 'Object does not exist');
      if (repo.refs.has(ref)) fail(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return { result: { status: 201, body: { ref, object: { sha, type: 'commit' } } } };
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        // List all refs.
        return {
          result: {
            status: 200,
            body: store.sortedRefs(repo).map(({ name, oid }) => ({ ref: name, object: { sha: oid, type: 'commit' } })),
          },
        };
      }
      // /git/refs/heads/{branch} or /git/refs/tags/{tag}.
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) fail(404, 'Not Found');
      return { result: { status: 200, body: { ref, object: { sha: oid, type: 'commit' } } } };
    }
    fail(405, 'Method Not Allowed');
  }

  // ---- contents
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    return handleContents(ctx, repo, path);
  }

  // ---- labels
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      if (!isRecord(ctx.body)) fail(400, 'Invalid request body');
      const labelName = reqString(ctx.body, 'name');
      if (labelName === '') fail(422, 'name is required');
      if (repo.labels.some((l) => l.name === labelName)) fail(422, 'Label already exists');
      const color = typeof ctx.body.color === 'string' && ctx.body.color !== '' ? ctx.body.color : 'ededed';
      const label = { name: labelName, color, description: '' };
      repo.labels.push(label);
      return { result: { status: 201, body: { ...label } } };
    }
    if (method === 'GET' && rest.length === 1) {
      return { result: { status: 200, body: repo.labels.map((l) => ({ ...l })) } };
    }
    fail(405, 'Method Not Allowed');
  }

  // ---- issues
  if (head === 'issues') {
    return handleIssues(ctx, repo, rest.slice(1));
  }

  // ---- pulls
  if (head === 'pulls') {
    return handlePulls(ctx, repo, rest.slice(1));
  }

  fail(404, 'Not Found');
}

function handleContents(
  ctx: RestContext,
  repo: Repo,
  path: string,
): { result: RestResult; link?: string } {
  const { store, method } = ctx;
  const refParam = ctx.query.get('ref');
  const branch = refParam ?? repo.defaultBranch;

  if (method === 'GET') {
    const tip = store.branchTip(repo, branch);
    if (tip === undefined) fail(404, 'Not Found');
    if (path === '') {
      const dir = store.contentDir(repo, branch, '');
      if (dir === null) fail(404, 'Not Found');
      return { result: { status: 200, body: dir } };
    }
    const blobOid = store.contentBlob(repo, branch, path);
    if (blobOid !== null) {
      const blob = store.getObject(repo, blobOid);
      if (blob === undefined) fail(404, 'Not Found');
      const name = path.split('/').pop() as string;
      return {
        result: {
          status: 200,
          body: {
            type: 'file',
            encoding: 'base64',
            content: blob.data.toString('base64'),
            sha: blobOid,
            size: blob.data.length,
            name,
            path,
          },
        },
      };
    }
    const dir = store.contentDir(repo, branch, path);
    if (dir !== null) return { result: { status: 200, body: dir } };
    fail(404, 'Not Found');
  }

  if (method === 'PUT') {
    if (!isRecord(ctx.body)) fail(400, 'Invalid request body');
    const message = reqString(ctx.body, 'message') || `Update ${path}`;
    const contentB64 = reqString(ctx.body, 'content');
    if (contentB64 === '') fail(422, 'content is required');
    const content = Buffer.from(contentB64, 'base64');
    const targetBranch = typeof ctx.body.branch === 'string' && ctx.body.branch !== '' ? ctx.body.branch : repo.defaultBranch;
    // Create the branch on demand from the default tip (or unborn).
    if (store.branchTip(repo, targetBranch) === undefined) {
      const defaultTip = store.branchTip(repo, repo.defaultBranch);
      if (defaultTip !== undefined) repo.refs.set(`refs/heads/${targetBranch}`, defaultTip);
    }
    const current = store.contentBlob(repo, targetBranch, path);
    const shaParam = typeof ctx.body.sha === 'string' ? ctx.body.sha : '';
    if (current !== null) {
      if (shaParam === '') fail(422, 'sha is required to update a file');
      if (shaParam.toLowerCase() !== current.toLowerCase()) fail(409, 'sha does not match the current blob');
    }
    const { commitSha, contentSha, created } = store.writeContent(repo, targetBranch, path, content, message);
    const name = path.split('/').pop() as string;
    return {
      result: {
        status: created ? 201 : 200,
        body: {
          content: { name, path, sha: contentSha, size: content.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitSha, message },
        },
      },
    };
  }

  if (method === 'DELETE') {
    if (!isRecord(ctx.body)) fail(400, 'Invalid request body');
    const message = reqString(ctx.body, 'message') || `Delete ${path}`;
    const current = store.contentBlob(repo, branch, path);
    if (current === null) fail(404, 'Not Found');
    const shaParam = typeof ctx.body.sha === 'string' ? ctx.body.sha : '';
    if (shaParam !== '' && shaParam.toLowerCase() !== current.toLowerCase()) fail(409, 'sha does not match the current blob');
    const commitSha = store.deleteContent(repo, branch, path, message);
    if (commitSha === null) fail(404, 'Not Found');
    return { result: { status: 200, body: { commit: { sha: commitSha, message } } } };
  }

  fail(405, 'Method Not Allowed');
}

function handleIssues(
  ctx: RestContext,
  repo: Repo,
  rest: string[],
): { result: RestResult; link?: string } {
  const { store, method } = ctx;

  // /issues — list / create
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      const list = store.listIssues(repo, state, sort, direction);
      const { page, link } = paginate(list.map(issueJson), ctx.query, ctx.host, ctx.path);
      return { result: { status: 200, body: page }, link };
    }
    if (method === 'POST') {
      if (!isRecord(ctx.body)) fail(400, 'Invalid request body');
      const title = reqString(ctx.body, 'title');
      if (title === '') fail(422, 'title is required');
      const bodyText = typeof ctx.body.body === 'string' ? ctx.body.body : '';
      const labels = Array.isArray(ctx.body.labels) ? ctx.body.labels.filter((l): l is string => typeof l === 'string') : [];
      const created = store.createIssue(repo, title, bodyText, labels);
      if ('error' in created) fail(422, created.error);
      return { result: { status: 201, body: issueJson(created) } };
    }
    fail(405, 'Method Not Allowed');
  }

  // /issues/{n}
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) fail(404, 'Not Found');
  const issue = store.issueByNumber(repo, number);
  if (issue === undefined) fail(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return { result: { status: 200, body: issueJson(issue) } };
    if (method === 'PATCH') {
      if (!isRecord(ctx.body)) fail(400, 'Invalid request body');
      if (typeof ctx.body.state === 'string') {
        if (ctx.body.state !== 'open' && ctx.body.state !== 'closed') fail(422, 'Invalid state');
        issue.state = ctx.body.state;
      }
      if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
      if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
      issue.updatedAt = new Date().toISOString();
      return { result: { status: 200, body: issueJson(issue) } };
    }
    fail(405, 'Method Not Allowed');
  }

  // /issues/{n}/comments
  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'GET') {
      return { result: { status: 200, body: issue.comments.map(commentJson) } };
    }
    if (method === 'POST') {
      if (!isRecord(ctx.body)) fail(400, 'Invalid request body');
      const bodyText = reqString(ctx.body, 'body');
      if (bodyText === '') fail(422, 'body is required');
      const comment = store.addComment(repo, issue, bodyText);
      return { result: { status: 201, body: commentJson(comment) } };
    }
    fail(405, 'Method Not Allowed');
  }

  fail(404, 'Not Found');
}

function handlePulls(
  ctx: RestContext,
  repo: Repo,
  rest: string[],
): { result: RestResult; link?: string } {
  const { store, method } = ctx;

  // /pulls — list / create
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      const sorted = [...list].sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, link } = paginate(sorted.map((p) => pullJson(store, repo, p)), ctx.query, ctx.host, ctx.path);
      return { result: { status: 200, body: page }, link };
    }
    if (method === 'POST') {
      if (!isRecord(ctx.body)) fail(400, 'Invalid request body');
      const title = reqString(ctx.body, 'title');
      const head = reqString(ctx.body, 'head');
      const base = reqString(ctx.body, 'base');
      if (title === '' || head === '' || base === '') fail(422, 'title, head and base are required');
      const bodyText = typeof ctx.body.body === 'string' ? ctx.body.body : '';
      const created = store.createPull(repo, title, bodyText, head, base);
      if ('error' in created) fail(422, created.error);
      return { result: { status: 201, body: pullJson(store, repo, created) } };
    }
    fail(405, 'Method Not Allowed');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) fail(404, 'Not Found');
  const pull = store.pullByNumber(repo, number);

  // /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') fail(405, 'Method Not Allowed');
    if (pull === undefined) fail(404, 'Not Found');
    const files = store.pullFiles(repo, pull).map((f: FileChange) => ({
      filename: f.path,
      status: f.status === 'removed' ? 'removed' : f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.additions + f.deletions,
    }));
    return { result: { status: 200, body: files } };
  }

  // /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') fail(405, 'Method Not Allowed');
    if (pull === undefined) fail(404, 'Not Found');
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) {
      if (merged.error === 'not-found') fail(404, 'Not Found');
      fail(405, merged.error === 'conflict' ? 'Merge conflict' : 'Pull request is already closed');
    }
    return {
      result: {
        status: 200,
        body: { sha: merged.sha, merged: true, message: 'Pull request successfully merged' },
      },
    };
  }

  if (rest.length === 1) {
    if (method !== 'GET') fail(405, 'Method Not Allowed');
    if (pull === undefined) fail(404, 'Not Found');
    return { result: { status: 200, body: pullJson(store, repo, pull) } };
  }

  fail(404, 'Not Found');
}

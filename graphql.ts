// graphql.ts — GitHub GraphQL v4 for the documents the suite sends (gh / github-mcp-server
// shapes): a small lexer + recursive-descent parser, a typed executor over the Store,
// opaque global ids, cursor pagination and batched operations.

import { type Store, type Repo, type Issue, type Pull, VIEWER_LOGIN, userInfo } from './store.ts';

// ---------------------------------------------------------------- lexer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL syntax error: unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

export interface Selection {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: Selection[];
  /** Inline fragment (`... on Type { ... }`): the type condition, if any. */
  fragmentType: string | null;
}

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

class Parser {
  tokens: Token[];
  pos = 0;

  constructor(input: string) {
    this.tokens = lex(input);
  }

  peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  next(): Token {
    const t = this.tokens[this.pos] as Token;
    this.pos += 1;
    return t;
  }

  expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`GraphQL syntax error: expected "${value}", got "${t.value}"`);
  }

  expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`GraphQL syntax error: expected a name, got "${t.value}"`);
    if (value !== undefined && t.value !== value) throw new Error(`GraphQL syntax error: expected "${value}", got "${t.value}"`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const n = this.peek();
      if (n.kind === 'name') name = this.next().value;
    }
    // Variable definitions: ($x: Type = default, ...)
    if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipParens();
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  /** Skip a balanced (...) group (variable definitions). */
  skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === 'eof') throw new Error('GraphQL syntax error: unterminated variable definitions');
      if (t.kind === 'punct' && t.value === '(') depth += 1;
      else if (t.kind === 'punct' && t.value === ')') depth -= 1;
    }
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('GraphQL syntax error: unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  parseSelection(): Selection {
    if (this.peek().kind === 'spread') {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeName = this.expectName();
        const selections = this.parseSelectionSet();
        return { alias: null, name: '__fragment', args: {}, selections, fragmentType: typeName };
      }
      throw new Error('GraphQL syntax error: named fragments are not supported');
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, unknown> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        const value = this.parseValue();
        args[argName] = value;
        if (this.peek().kind === 'punct' && this.peek().value === ',') this.next();
      }
      this.expectPunct(')');
    }
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections, fragmentType: null };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number.parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: Number.parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`GraphQL syntax error: unexpected value token "${t.value}"`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- global ids

export function globalId(kind: string, ref: string): string {
  return Buffer.from(`${kind}:${ref}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; ref: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx === -1) return null;
    return { kind: text.slice(0, idx), ref: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
}

// ---------------------------------------------------------------- schema (for validation + introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'id', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt',
  ],
  User: ['login', 'id', 'name'],
  BranchRef: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files',
    'body', 'createdAt', 'updatedAt', 'mergedAt',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'createdAt'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION', 'COMMIT', 'DISCUSSION', 'MILESTONE', 'CODE'],
};

// ---------------------------------------------------------------- executor

interface GqlContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

type Value = Record<string, unknown> | unknown[] | string | number | boolean | null;

interface TypedValue {
  type: string;
  value: unknown;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoByGlobalId(ctx: GqlContext, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const [owner, name] = parsed.ref.split('/');
  if (owner === undefined || name === undefined) return null;
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function issueByGlobalId(ctx: GqlContext, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [ownerRepo, num] = parsed.ref.split('#');
  if (ownerRepo === undefined || num === undefined) return null;
  const [owner, name] = ownerRepo.split('/');
  if (owner === undefined || name === undefined || owner !== VIEWER_LOGIN) return null;
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return null;
  const issue = repo.issues.find((i) => i.number === Number.parseInt(num, 10));
  if (issue === undefined) return null;
  return { repo, issue };
}

function pullByGlobalId(ctx: GqlContext, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [ownerRepo, num] = parsed.ref.split('#');
  if (ownerRepo === undefined || num === undefined) return null;
  const [owner, name] = ownerRepo.split('/');
  if (owner === undefined || name === undefined || owner !== VIEWER_LOGIN) return null;
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return null;
  const pull = repo.pulls.find((p) => p.number === Number.parseInt(num, 10));
  if (pull === undefined) return null;
  return { repo, pull };
}

function resolveArgs(sel: Selection, ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args)) out[k] = resolveValue(v as ValueNode, ctx.variables);
  return out;
}

function unknownField(ctx: GqlContext, typeName: string, field: string, path: Array<string | number>): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".`, path });
}

/** Execute a selection set against a typed value; returns the JSON value. */
function executeSelections(
  ctx: GqlContext,
  parent: TypedValue,
  selections: Selection[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.fragmentType !== null) {
      if (sel.fragmentType === parent.type) {
        Object.assign(out, executeSelections(ctx, parent, sel.selections, path));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    out[key] = resolveField(ctx, parent, sel, fieldPath);
  }
  return out;
}

function resolveField(ctx: GqlContext, parent: TypedValue, sel: Selection, path: Array<string | number>): Value {
  const typeName = parent.type;
  const allowed = TYPE_FIELDS[typeName];
  if (allowed !== undefined && !allowed.includes(sel.name) && sel.name !== '__typename') {
    unknownField(ctx, typeName, sel.name, path);
    return null;
  }
  if (sel.name === '__typename') return typeName;
  const args = resolveArgs(sel, ctx);
  const v = parent.value;

  switch (typeName) {
    case 'Query': {
      if (sel.name === 'viewer') {
        const u = userInfo(VIEWER_LOGIN);
        return executeSelections(ctx, { type: 'Viewer', value: u }, sel.selections, path);
      }
      if (sel.name === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (owner !== VIEWER_LOGIN || typeof name !== 'string') return null;
        const repo = ctx.store.getRepo(VIEWER_LOGIN, name);
        if (repo === undefined) return null;
        return executeSelections(ctx, { type: 'Repository', value: repo }, sel.selections, path);
      }
      if (sel.name === 'node') {
        const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = repoByGlobalId(ctx, args.id);
          if (repo === null) return null;
          return executeSelections(ctx, { type: 'Repository', value: repo }, sel.selections, path);
        }
        if (parsed.kind === 'Issue') {
          const found = issueByGlobalId(ctx, args.id);
          if (found === null) return null;
          return executeSelections(ctx, { type: 'Issue', value: { repo: found.repo, issue: found.issue } }, sel.selections, path);
        }
        if (parsed.kind === 'PullRequest') {
          const found = pullByGlobalId(ctx, args.id);
          if (found === null) return null;
          return executeSelections(ctx, { type: 'PullRequest', value: { repo: found.repo, pull: found.pull } }, sel.selections, path);
        }
        return null;
      }
      if (sel.name === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
        return executeSelections(ctx, { type: '__Type', value: { name } }, sel.selections, path);
      }
      return null;
    }
    case 'Mutation': {
      if (sel.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(ctx, input.repositoryId);
        if (repo === null) {
          ctx.errors.push({ message: 'Repository not found', path });
          return null;
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const created = ctx.store.createIssue(repo, title, body, []);
        if ('error' in created) {
          ctx.errors.push({ message: created.error, path });
          return null;
        }
        return executeSelections(ctx, { type: 'CreateIssuePayload', value: { repo, issue: created } }, sel.selections, path);
      }
      if (sel.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(ctx, input.issueId);
        if (found === null) {
          ctx.errors.push({ message: 'Issue not found', path });
          return null;
        }
        found.issue.state = 'closed';
        found.issue.updatedAt = new Date().toISOString();
        return executeSelections(ctx, { type: 'CloseIssuePayload', value: { repo: found.repo, issue: found.issue } }, sel.selections, path);
      }
      if (sel.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(ctx, input.repositoryId);
        if (repo === null) {
          ctx.errors.push({ message: 'Repository not found', path });
          return null;
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const created = ctx.store.createPull(repo, title, '', head, base);
        if ('error' in created) {
          ctx.errors.push({ message: created.error, path });
          return null;
        }
        return executeSelections(ctx, { type: 'CreatePullRequestPayload', value: { repo, pull: created } }, sel.selections, path);
      }
      if (sel.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullByGlobalId(ctx, input.pullRequestId);
        if (found === null) {
          ctx.errors.push({ message: 'Pull request not found', path });
          return null;
        }
        const merged = ctx.store.mergePull(found.repo, found.pull);
        if ('error' in merged) {
          ctx.errors.push({ message: `Cannot merge pull request: ${merged.error}`, path });
          return null;
        }
        return executeSelections(ctx, { type: 'MergePullRequestPayload', value: { repo: found.repo, pull: found.pull } }, sel.selections, path);
      }
      if (sel.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(ctx, input.subjectId);
        if (found === null) {
          ctx.errors.push({ message: 'Subject not found', path });
          return null;
        }
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = ctx.store.addComment(found.repo, found.issue, body);
        const node = { id: globalId('IssueComment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${comment.id}`), body: comment.body };
        return executeSelections(ctx, { type: 'AddCommentPayload', value: { node } }, sel.selections, path);
      }
      return null;
    }
    case 'Viewer': {
      const u = v as { login: string; id: number; name: string };
      if (sel.name === 'login') return u.login;
      if (sel.name === 'id') return String(u.id);
      if (sel.name === 'name') return u.name;
      return null;
    }
    case 'Repository': {
      const repo = v as Repo;
      switch (sel.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner': {
          const u = userInfo(repo.owner);
          return executeSelections(ctx, { type: 'User', value: u }, sel.selections, path);
        }
        case 'defaultBranchRef': {
          const tip = ctx.store.branchTip(repo, repo.defaultBranch);
          if (tip === undefined) return null;
          return executeSelections(ctx, { type: 'BranchRef', value: { name: repo.defaultBranch } }, sel.selections, path);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'issue': {
          const num = args.number;
          if (typeof num !== 'number') return null;
          const issue = repo.issues.find((i) => i.number === num);
          if (issue === undefined) return null;
          return executeSelections(ctx, { type: 'Issue', value: { repo, issue } }, sel.selections, path);
        }
        case 'issues': {
          const list = issuesConnection(ctx, repo, args);
          return executeSelections(ctx, { type: 'IssueConnection', value: list }, sel.selections, path);
        }
        case 'pullRequests': {
          const list = pullsConnection(ctx, repo, args);
          return executeSelections(ctx, { type: 'PullRequestConnection', value: list }, sel.selections, path);
        }
        case 'pullRequest': {
          const num = args.number;
          if (typeof num !== 'number') return null;
          const pull = repo.pulls.find((p) => p.number === num);
          if (pull === undefined) return null;
          return executeSelections(ctx, { type: 'PullRequest', value: { repo, pull } }, sel.selections, path);
        }
        default:
          return null;
      }
    }
    case 'User': {
      const u = v as { login: string; id: number; name: string };
      if (sel.name === 'login') return u.login;
      if (sel.name === 'id') return String(u.id);
      if (sel.name === 'name') return u.name;
      return null;
    }
    case 'BranchRef': {
      const b = v as { name: string };
      if (sel.name === 'name') return b.name;
      return null;
    }
    case 'Issue': {
      const { repo, issue } = v as { repo: Repo; issue: Issue };
      switch (sel.name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = v as { repo: Repo; pull: Pull };
      switch (sel.name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'state':
          return pullState(pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return ctx.store.pullMergeable(repo, pull);
        case 'merged':
          return pull.merged;
        case 'body':
          return pull.body;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'mergedAt':
          return pull.mergedAt;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const files = ctx.store.pullFiles(repo, pull).slice(0, first);
          const conn = { nodes: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, changeType: f.status })), pageInfo: { hasNextPage: false, endCursor: null } };
          return executeSelections(ctx, { type: 'PullRequestFileConnection', value: conn }, sel.selections, path);
        }
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      const conn = v as { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; totalCount: number };
      if (sel.name === 'nodes') {
        const nodeType = typeName === 'IssueConnection' ? 'Issue' : 'PullRequest';
        return conn.nodes.map((n, i) =>
          executeSelections(ctx, { type: nodeType, value: n }, sel.selections, [...path, i]),
        );
      }
      if (sel.name === 'pageInfo') {
        return executeSelections(ctx, { type: 'PageInfo', value: conn.pageInfo }, sel.selections, path);
      }
      if (sel.name === 'totalCount') return conn.totalCount;
      return null;
    }
    case 'PullRequestFileConnection': {
      const conn = v as { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (sel.name === 'nodes') {
        return conn.nodes.map((n, i) => executeSelections(ctx, { type: 'PullRequestFile', value: n }, sel.selections, [...path, i]));
      }
      if (sel.name === 'pageInfo') {
        return executeSelections(ctx, { type: 'PageInfo', value: conn.pageInfo }, sel.selections, path);
      }
      return null;
    }
    case 'PageInfo': {
      const p = v as { hasNextPage: boolean; endCursor: string | null; hasPreviousPage?: boolean; startCursor?: string | null };
      if (sel.name === 'hasNextPage') return p.hasNextPage;
      if (sel.name === 'endCursor') return p.endCursor;
      if (sel.name === 'hasPreviousPage') return p.hasPreviousPage ?? false;
      if (sel.name === 'startCursor') return p.startCursor ?? null;
      return null;
    }
    case 'PullRequestFile': {
      const f = v as { path: string; additions: number; deletions: number; changeType: string };
      if (sel.name === 'path') return f.path;
      if (sel.name === 'additions') return f.additions;
      if (sel.name === 'deletions') return f.deletions;
      if (sel.name === 'changeType') return f.changeType;
      return null;
    }
    case 'IssueComment': {
      const c = v as { id: string; body: string };
      if (sel.name === 'id') return c.id;
      if (sel.name === 'body') return c.body;
      return null;
    }
    case 'CommentEdge': {
      const e = v as { node: { id: string; body: string }; cursor?: string };
      if (sel.name === 'node') {
        return executeSelections(ctx, { type: 'IssueComment', value: e.node }, sel.selections, path);
      }
      if (sel.name === 'cursor') return e.cursor ?? null;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const p = v as { repo: Repo; issue: Issue };
      if (sel.name === 'issue') {
        return executeSelections(ctx, { type: 'Issue', value: p }, sel.selections, path);
      }
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const p = v as { repo: Repo; pull: Pull };
      if (sel.name === 'pullRequest') {
        return executeSelections(ctx, { type: 'PullRequest', value: p }, sel.selections, path);
      }
      return null;
    }
    case 'AddCommentPayload': {
      const p = v as { node: { id: string; body: string } };
      if (sel.name === 'commentEdge') {
        return executeSelections(ctx, { type: 'CommentEdge', value: { node: p.node } }, sel.selections, path);
      }
      return null;
    }
    case '__Type': {
      const t = v as { name: string };
      if (sel.name === 'name') return t.name;
      if (sel.name === 'fields') {
        const fields = (TYPE_FIELDS[t.name] ?? []).map((name) => ({ name }));
        return fields.map((f, i) => executeSelections(ctx, { type: '__Field', value: f }, sel.selections, [...path, i]));
      }
      if (sel.name === 'enumValues') {
        const values = (ENUM_VALUES[t.name] ?? []).map((name) => ({ name }));
        return values.map((f, i) => executeSelections(ctx, { type: '__EnumValue', value: f }, sel.selections, [...path, i]));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      const f = v as { name: string };
      if (sel.name === 'name') return f.name;
      return null;
    }
    default:
      return null;
  }
}

function issuesConnection(
  ctx: GqlContext,
  repo: Repo,
  args: Record<string, unknown>,
): { nodes: Array<{ repo: Repo; issue: Issue }>; pageInfo: { hasNextPage: boolean; endCursor: string | null }; totalCount: number } {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const direction = orderBy !== undefined && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const first = typeof args.first === 'number' ? args.first : 10;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  const start = after === null ? 0 : after + 1;
  const slice = list.slice(start, start + first);
  const endCursor = slice.length > 0 ? encodeCursor(start + slice.length - 1) : null;
  return {
    nodes: slice.map((issue) => ({ repo, issue })),
    pageInfo: { hasNextPage: start + slice.length < list.length, endCursor },
    totalCount: list.length,
  };
}

function pullsConnection(
  ctx: GqlContext,
  repo: Repo,
  args: Record<string, unknown>,
): { nodes: Array<{ repo: Repo; pull: Pull }>; pageInfo: { hasNextPage: boolean; endCursor: string | null }; totalCount: number } {
  let list = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((p) => wanted.has(pullState(p)));
  } else {
    list = list.filter((p) => p.state === 'open');
  }
  list.sort((a, b) => b.createdSeq - a.createdSeq);
  const first = typeof args.first === 'number' ? args.first : 10;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  const start = after === null ? 0 : after + 1;
  const slice = list.slice(start, start + first);
  const endCursor = slice.length > 0 ? encodeCursor(start + slice.length - 1) : null;
  return {
    nodes: slice.map((pull) => ({ repo, pull })),
    pageInfo: { hasNextPage: start + slice.length < list.length, endCursor },
    totalCount: list.length,
  };
}

// ---------------------------------------------------------------- entry points

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>): GraphQLResult {
  const ctx: GqlContext = { store, variables, errors: [] };
  try {
    const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelections(ctx, { type: rootType, value: {} }, op.selections, []);
    const result: GraphQLResult = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
}

/** Execute one GraphQL request body (single operation or a batch array). */
export function handleGraphQL(store: Store, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'Invalid operation' }] };
      const op = entry as { query?: unknown; variables?: unknown };
      if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'Missing query' }] };
      return executeDocument(store, op.query, (op.variables ?? {}) as Record<string, unknown>);
    });
  }
  if (typeof body !== 'object' || body === null) return { data: null, errors: [{ message: 'Invalid request body' }] };
  const op = body as { query?: unknown; variables?: unknown };
  if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'Missing query' }] };
  return executeDocument(store, op.query, (op.variables ?? {}) as Record<string, unknown>);
}

function executeDocument(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  let ops: Operation[];
  try {
    ops = new Parser(query).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax Error' }] };
  }
  if (ops.length === 0) return { data: null, errors: [{ message: 'Empty document' }] };
  // The suite sends one operation per document (batching is done at the HTTP level).
  return executeOperation(store, ops[0] as Operation, variables);
}

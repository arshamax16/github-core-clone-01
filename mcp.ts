// mcp.ts — Model Context Protocol over Streamable HTTP at /mcp, modern 2026-07-28 era:
// server/discover (no handshake, no session), tools/list, tools/call. Every tool acts on
// the same Store the REST and GraphQL surfaces use.

import { type Store, type Repo, VIEWER_LOGIN, userInfo } from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool list: a fixed constant, so two tools/list answers are byte-identical. */
export const MCP_TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The owner login (the authenticated user).' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolByName(name: string): ToolDef | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}

/** Run one tool against the store; returns a result or an error message. */
function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const tool = toolByName(name);
  if (tool === undefined) return errorResult(`Unknown tool: ${name}`);
  // Required-argument check (the missing-arguments check expects isError or -32602).
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return errorResult(`Missing required argument: ${required}`);
    }
  }
  const owner = asString(args.owner) || VIEWER_LOGIN;
  const repoName = asString(args.repo);
  if (name === 'create_repo') {
    const repoNameArg = asString(args.name);
    if (repoNameArg === '') return errorResult('Missing required argument: name');
    if (store.getRepo(VIEWER_LOGIN, repoNameArg) !== undefined) return errorResult('Repository already exists');
    const repo = store.createRepo(
      VIEWER_LOGIN,
      repoNameArg,
      args.private === true,
      asString(args.description),
    );
    return textResult(repoJson(repo));
  }
  if (repoName === '') return errorResult('Missing required argument: repo');
  const repo = store.getRepo(owner, repoName) as Repo | undefined;
  if (repo === undefined) return errorResult('Repository not found');

  switch (name) {
    case 'get_repo':
      return textResult(repoJson(repo));
    case 'create_issue': {
      const title = asString(args.title);
      const body = asString(args.body);
      const created = store.createIssue(repo, title, body, []);
      if ('error' in created) return errorResult(created.error);
      return textResult(issueJson(created));
    }
    case 'list_issues': {
      const state = asString(args.state) || 'open';
      const list = store.listIssues(repo, state, 'created', 'desc');
      return textResult(list.map(issueJson));
    }
    case 'create_pull_request': {
      const title = asString(args.title);
      const body = asString(args.body);
      const head = asString(args.head);
      const base = asString(args.base);
      const created = store.createPull(repo, title, body, head, base);
      if ('error' in created) return errorResult(created.error);
      return textResult(pullJson(store, repo, created));
    }
    case 'merge_pull_request': {
      const number = asNumber(args.pull_number);
      if (number === null) return errorResult('Missing required argument: pull_number');
      const pull = store.pullByNumber(repo, number);
      if (pull === undefined) return errorResult('Pull request not found');
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return errorResult(`Cannot merge pull request: ${merged.error}`);
      return textResult({ ...pullJson(store, repo, pull), sha: merged.sha, merged: true });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, error: JsonRpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

function serverInfo(): Record<string, unknown> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

/**
 * Handle one POST /mcp body (already read as text). Returns the HTTP status and the
 * JSON body to send. `bodyText` may be malformed JSON (handled here: 400 + -32700).
 */
export function handleMcp(store: Store, bodyText: string): { status: number; body: unknown } {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) get no JSON-RPC response; answer 202 with no body.
  if (req.id === undefined) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: [MCP_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
        instructions: 'A GitHub-compatible forge: repositories, issues, pull requests, git, GraphQL and MCP tools.',
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      }),
    };
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
      }),
    };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: MCP_TOOLS }) };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (toolByName(name) === undefined) {
      return { status: 200, body: rpcError(id, { code: -32602, message: `Unknown tool: ${name}` }) };
    }
    const tool = toolByName(name) as ToolDef;
    const missing = tool.inputSchema.required.filter(
      (r) => args[r] === undefined || args[r] === null || args[r] === '',
    );
    if (missing.length > 0) {
      return {
        status: 200,
        body: rpcError(id, { code: -32602, message: `Missing required argument: ${missing.join(', ')}` }),
      };
    }
    const result = callTool(store, name, args);
    return { status: 200, body: rpcResult(id, result) };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  return { status: 200, body: rpcError(id, { code: -32601, message: `Method not found: ${method}` }) };
}

export { userInfo };

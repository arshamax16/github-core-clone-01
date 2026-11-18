// store.ts — the forge's in-memory store: users, repositories, objects, refs, issues,
// pull requests, labels and comments. All state lives here; nothing touches disk.

import {
  ZERO_OID,
  hashObject,
  parseCommit,
  buildCommit,
  parseTree,
  buildTree,
  blobAt,
  treeAt,
  flattenTree,
  diffTrees,
  threeWayMerge,
  treeWithPath,
  firstParentChain,
  mergeBase,
  reachable,
  type GitObject,
  type GitObjectType,
  type FileChange,
} from './gitcore.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const STRANGER_ID = 1002;
export const TEAMMATE_LOGIN = 'quinnkeller';
export const ORG_LOGIN = 'faint-meadow-org';
export const DEFAULT_BRANCH = 'main';
export const FIXED_EPOCH = 1700000000;

export interface UserInfo {
  login: string;
  id: number;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export function userInfo(login: string): UserInfo {
  if (login === VIEWER_LOGIN) return { login, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
  if (login === STRANGER_LOGIN) return { login, id: STRANGER_ID, name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' };
  if (login === TEAMMATE_LOGIN) return { login, id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' };
  if (login === ORG_LOGIN) return { login, id: 2000, name: 'faint meadow org', email: '', type: 'Organization' };
  return { login, id: 5000, name: login, email: '', type: 'User' };
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  user: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  /** Cached JSON serialization of this issue (rest.ts); cleared on any mutation. */
  jsonCache: Buffer | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** Base tip at creation (the merge-base reference). */
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

export class Store {
  repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  nextRepoId = 1;
  nextGlobalId = 1;
  seq = 0;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.seq,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.nextRepoId += 1;
    this.seq += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // ------------------------------------------------------------ objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  objectGetter(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  // ------------------------------------------------------------ refs

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** The tip of a branch name (refs/heads/<name>), or undefined when unborn. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** All refs sorted by name. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Branch names sorted. */
  branchNames(repo: Repo): string[] {
    const out: string[] = [];
    for (const name of repo.refs.keys()) {
      if (name.startsWith('refs/heads/')) out.push(name.slice('refs/heads/'.length));
    }
    out.sort();
    return out;
  }

  /** The commit oid a ref resolves to (peeling annotated tags). */
  peelToCommit(repo: Repo, oid: string): string | null {
    let cur = oid;
    for (let i = 0; i < 10; i += 1) {
      const obj = repo.objects.get(cur);
      if (obj === undefined) return null;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        const m = /^object ([0-9a-f]{40})$/m.exec(text);
        if (m === null) return null;
        cur = m[1] as string;
        continue;
      }
      return null;
    }
    return null;
  }

  // ------------------------------------------------------------ commits

  /** Create a commit on `branch` (creating the branch when absent). */
  commitOnBranch(
    repo: Repo,
    branch: string,
    treeOid: string,
    message: string,
    author?: string,
  ): string {
    const parent = this.branchTip(repo, branch);
    const ident = author ?? `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`;
    const commit = buildCommit({
      tree: treeOid,
      parents: parent === undefined ? [] : [parent],
      message,
      author: ident,
      committer: ident,
    });
    const oid = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** The first-parent history of a branch tip, newest first. */
  branchHistory(repo: Repo, branch: string): string[] {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return [];
    return firstParentChain(this.objectGetter(repo), tip);
  }

  /** A commit's parsed data, or null. */
  commitOf(repo: Repo, oid: string): { tree: string; parents: string[]; message: string } | null {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    const c = parseCommit(obj.data);
    return { tree: c.tree, parents: c.parents, message: c.message.replace(/\n$/, '') };
  }

  // ------------------------------------------------------------ contents

  /** The blob oid at `path` on `branch`, or null. */
  contentBlob(repo: Repo, branch: string, path: string): string | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const commit = this.commitOf(repo, tip);
    if (commit === null) return null;
    return blobAt(this.objectGetter(repo), commit.tree, path);
  }

  /** Directory entries at `path` on `branch` ("" = root), or null when not a directory. */
  contentDir(
    repo: Repo,
    branch: string,
    path: string,
  ): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const commit = this.commitOf(repo, tip);
    if (commit === null) return null;
    const entries = treeAt(this.objectGetter(repo), commit.tree, path);
    if (entries === null) return null;
    const base = path === '' ? '' : `${path.replace(/\/$/, '')}/`;
    return entries
      .map((e) => ({
        name: e.name,
        path: `${base}${e.name}`,
        sha: e.oid,
        type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Write `content` at `path` on `branch`, creating a commit. Returns commit + blob oids. */
  writeContent(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string; created: boolean } {
    const tip = this.branchTip(repo, branch);
    const existed = tip !== undefined && this.contentBlob(repo, branch, path) !== null;
    const blobOid = this.putObject(repo, 'blob', content);
    const baseTree = tip === undefined ? null : (this.commitOf(repo, tip)?.tree ?? null);
    const treeOid = treeWithPath(
      this.objectGetter(repo),
      (t, d) => this.putObject(repo, t, d),
      baseTree,
      path,
      blobOid,
    );
    const commitSha = this.commitOnBranch(repo, branch, treeOid, message);
    return { commitSha, contentSha: blobOid, created: !existed };
  }

  /** Delete `path` on `branch`, creating a commit. Returns the commit oid or null. */
  deleteContent(repo: Repo, branch: string, path: string, message: string): string | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const commit = this.commitOf(repo, tip);
    if (commit === null) return null;
    if (blobAt(this.objectGetter(repo), commit.tree, path) === null) return null;
    const treeOid = treeWithPath(
      this.objectGetter(repo),
      (t, d) => this.putObject(repo, t, d),
      commit.tree,
      path,
      null,
    );
    return this.commitOnBranch(repo, branch, treeOid, message);
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const found = repo.labels.find((l) => l.name === name);
      if (found === undefined) return { error: `unknown label "${name}"` };
      labels.push(found);
    }
    const now = new Date().toISOString();
    const issue: Issue = {
      id: this.nextGlobalId,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      user: VIEWER_LOGIN,
      createdSeq: this.seq,
      createdAt: now,
      updatedAt: now,
      jsonCache: null,
    };
    this.nextGlobalId += 1;
    this.seq += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  issueByNumber(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  listIssues(repo: Repo, state: string, sort: string, direction: string): Issue[] {
    let list = repo.issues.filter((i) => state === 'all' || i.state === state);
    const asc = direction === 'asc';
    list = [...list].sort((a, b) => (asc ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    void sort;
    return list;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = {
      id: this.nextGlobalId,
      body,
      user: VIEWER_LOGIN,
      createdAt: new Date().toISOString(),
    };
    this.nextGlobalId += 1;
    issue.comments.push(comment);
    issue.updatedAt = new Date().toISOString();
    issue.jsonCache = null;
    return comment;
  }

  // ------------------------------------------------------------ pull requests

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headTip = this.branchTip(repo, head);
    if (headTip === undefined) return { error: `head branch "${head}" does not exist` };
    const baseTip = this.branchTip(repo, base);
    if (baseTip === undefined) return { error: `base branch "${base}" does not exist` };
    const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (existing !== undefined) return { error: 'a pull request is already open for this head and base' };
    const now = new Date().toISOString();
    const pull: Pull = {
      id: this.nextGlobalId,
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      headRef: head,
      baseRef: base,
      baseShaAtCreate: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: VIEWER_LOGIN,
      createdSeq: this.seq,
      createdAt: now,
      updatedAt: now,
    };
    this.nextGlobalId += 1;
    this.seq += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  pullByNumber(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  headSha(repo: Repo, pull: Pull): string {
    return this.branchTip(repo, pull.headRef) ?? pull.baseShaAtCreate;
  }

  baseSha(repo: Repo, pull: Pull): string {
    return this.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  }

  /** The files a pull request changes (merge-base of head/base vs head tip). */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const get = this.objectGetter(repo);
    const headTip = this.branchTip(repo, pull.headRef);
    if (headTip === undefined) return [];
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
    const base = mergeBase(get, headTip, baseTip) ?? pull.baseShaAtCreate;
    const baseCommit = this.commitOf(repo, base);
    const headCommit = this.commitOf(repo, headTip);
    if (baseCommit === null || headCommit === null) return [];
    return diffTrees(get, baseCommit.tree, headCommit.tree);
  }

  /** Whether a pull request would merge cleanly (without applying). */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const get = this.objectGetter(repo);
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    const base = mergeBase(get, headTip, baseTip);
    if (base === null) return 'UNKNOWN';
    const baseCommit = this.commitOf(repo, base);
    const headCommit = this.commitOf(repo, headTip);
    const baseTipCommit = this.commitOf(repo, baseTip);
    if (baseCommit === null || headCommit === null || baseTipCommit === null) return 'UNKNOWN';
    const result = threeWayMerge(
      get,
      (t, d) => hashObject(t, d),
      baseCommit.tree,
      baseTipCommit.tree,
      headCommit.tree,
    );
    return result.ok ? 'MERGEABLE' : 'CONFLICTING';
  }

  /**
   * Squash-merge a pull request onto its base branch.
   * Returns the merge commit oid, or an error string ('not-found' | 'conflict' | 'closed').
   */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'closed' };
    const get = this.objectGetter(repo);
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return { error: 'not-found' };
    const base = mergeBase(get, headTip, baseTip);
    if (base === null) return { error: 'not-found' };
    const baseCommit = this.commitOf(repo, base);
    const headCommit = this.commitOf(repo, headTip);
    const baseTipCommit = this.commitOf(repo, baseTip);
    if (baseCommit === null || headCommit === null || baseTipCommit === null) return { error: 'not-found' };
    const put = (t: GitObjectType, d: Buffer): string => this.putObject(repo, t, d);
    const result = threeWayMerge(get, put, baseCommit.tree, baseTipCommit.tree, headCommit.tree);
    if (!result.ok || result.treeOid === null) return { error: 'conflict' };
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`;
    const mergeCommit = buildCommit({
      tree: result.treeOid,
      parents: [baseTip],
      message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n`,
      author: ident,
      committer: ident,
    });
    const sha = this.putObject(repo, 'commit', mergeCommit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = sha;
    pull.updatedAt = new Date().toISOString();
    return { sha };
  }

  // ------------------------------------------------------------ misc

  /** The flattened file map of a commit's tree. */
  flattenCommitTree(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string }> {
    const commit = this.commitOf(repo, commitOid);
    if (commit === null) return new Map();
    return flattenTree(this.objectGetter(repo), commit.tree);
  }

  reachableFrom(repo: Repo, tips: string[]): Set<string> {
    return reachable(this.objectGetter(repo), tips);
  }
}

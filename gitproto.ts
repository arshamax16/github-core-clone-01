// gitproto.ts — git smart HTTP: upload-pack (protocol v0 and v2) and receive-pack (v0).
// Speaks the wire the suite's git client drives: advertisements, ls-refs, fetch with
// haves/depth/shallow, packfiles in sideband, receive-pack with report-status.

import {
  ZERO_OID,
  pktLine,
  PKT_FLUSH,
  PKT_DELIM,
  parsePktLines,
  parsePack,
  writePack,
  hashObject,
  parseCommit,
  parseTree,
  parseTag,
  reachable,
  firstParentChain,
  type GitObject,
  type GitObjectType,
  type PackEntry,
} from './gitcore.ts';
import { type Repo, type Store } from './store.ts';

const AGENT = 'github-core-clone/1.0.0';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function okResult(contentType: string, body: Buffer): GitHttpResult {
  return { status: 200, contentType, body };
}

function errResult(status: number, message: string): GitHttpResult {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** A ref line for an advertisement: "<oid> <name>" with optional caps after NUL. */
function refLine(oid: string, name: string, caps?: string): Buffer {
  const text = caps === undefined ? `${oid} ${name}\n` : `${oid} ${name}\0${caps}\n`;
  return pktLine(text);
}

/** The refs a repo advertises (HEAD first, then heads/tags sorted), with caps on the first. */
function advertisedRefs(repo: Repo, caps: string): Buffer[] {
  const out: Buffer[] = [];
  const refs = repo.refs;
  const defaultTip = refs.get('refs/heads/main');
  let first = true;
  const put = (oid: string, name: string): void => {
    out.push(refLine(oid, name, first ? caps : undefined));
    first = false;
  };
  if (defaultTip !== undefined) put(defaultTip, 'HEAD');
  const sorted = [...refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of sorted) put(oid, name);
  return out;
}

/** v0 upload-pack advertisement. */
export function advertisementUploadPack(repo: Repo): GitHttpResult {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const caps = 'side-band-64k thin-pack ofs-delta symref=HEAD:refs/heads/main agent=' + AGENT;
  if (repo.refs.size === 0) {
    // An empty repository advertises no refs at all.
  } else {
    parts.push(...advertisedRefs(repo, caps));
  }
  parts.push(PKT_FLUSH);
  return okResult('application/x-git-upload-pack-advertisement', Buffer.concat(parts));
}

/** v0 receive-pack advertisement. */
export function advertisementReceivePack(repo: Repo): GitHttpResult {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const caps = 'report-status side-band-64k delete-refs agent=' + AGENT;
  if (repo.refs.size === 0) {
    // No refs yet: a capabilities pseudo-ref carries the capabilities (zero oid).
    parts.push(refLine(ZERO_OID, 'capabilities^{}', caps));
  } else {
    parts.push(...advertisedRefs(repo, caps));
  }
  parts.push(PKT_FLUSH);
  return okResult('application/x-git-receive-pack-advertisement', Buffer.concat(parts));
}

/** v2 advertisement (sent when the client asked for protocol version 2). */
export function advertisementV2(): GitHttpResult {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ];
  return okResult('application/x-git-upload-pack-advertisement', Buffer.concat(parts));
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  deepen: number; // 0 = not requested
  thinPack: boolean;
  noProgress: boolean;
  ofsDelta: boolean;
  /** The client sent `done`: negotiation is over, so the response must NOT carry
   * an acknowledgments section (real git goes straight to the packfile section). */
  done: boolean;
}

function parseFetchArgs(items: ReturnType<typeof parsePktLines>): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallowLines: [], deepen: 0, thinPack: false, noProgress: false, ofsDelta: false, done: false };
  for (const item of items) {
    if (item.kind !== 'line') continue;
    const text = item.data.toString('utf8').trimEnd();
    if (text.startsWith('want ')) req.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallowLines.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) req.deepen = Number.parseInt(text.slice(7).trim(), 10) || 0;
    else if (text === 'thin-pack') req.thinPack = true;
    else if (text === 'no-progress') req.noProgress = true;
    else if (text === 'ofs-delta') req.ofsDelta = true;
    else if (text === 'done') req.done = true;
  }
  return req;
}

interface WalkResult {
  /** Commits included, with their depth from the nearest want (1-based). */
  commits: Map<string, number>;
  /** All objects to send (commits + trees + blobs), in walk order. */
  objects: PackEntry[];
  /** Boundary commits at the depth limit (shallow). */
  boundary: string[];
  /** Former shallow commits now fully included (unshallow). */
  unshallowed: string[];
}

/**
 * Walk from `wants` up to `maxDepth` levels (0 = unlimited), excluding anything
 * reachable from `haves`. Returns the objects to pack plus shallow bookkeeping.
 */
function walkForFetch(repo: Repo, req: FetchRequest): WalkResult {
  const get = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(req.shallowLines);
  // Objects the client already holds: reachable from its haves, except that a
  // shallow-boundary commit contributes itself and its tree, not its parents —
  // a deepen fetch must re-send those parents (they are below the boundary).
  const haveReach = new Set<string>();
  {
    const stack = [...req.haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (haveReach.has(oid)) continue;
      const obj = get(oid);
      if (obj === undefined) continue;
      haveReach.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        if (!shallowSet.has(oid)) for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  }
  const maxDepth = req.deepen > 0 ? req.deepen : 0;
  const commits = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  // Commits whose parents this walk actually followed (for unshallow reporting).
  const descended = new Set<string>();
  // Non-commit wants (annotated tags, or a direct tree/blob want) are collected
  // here and added to the pack after the commit walk; a tag's target commit
  // still seeds the walk so its history and tree are included.
  const extraWants: string[] = [];
  const seedCommit = (oid: string): void => {
    if (!commits.has(oid) && get(oid)?.type === 'commit') {
      commits.set(oid, 1);
      queue.push({ oid, depth: 1 });
    }
  };
  for (const w of req.wants) {
    const obj = get(w);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      seedCommit(w);
    } else if (obj.type === 'tag') {
      extraWants.push(w);
      let target = parseTag(obj.data).object;
      for (let hops = 0; hops < 8; hops += 1) {
        const t = get(target);
        if (t === undefined) break;
        if (t.type === 'commit') {
          seedCommit(target);
          break;
        }
        if (t.type === 'tag') {
          extraWants.push(target);
          target = parseTag(t.data).object;
          continue;
        }
        extraWants.push(target);
        break;
      }
    } else {
      extraWants.push(w);
    }
  }
  const boundary: string[] = [];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi] as { oid: string; depth: number };
    qi += 1;
    if (maxDepth > 0 && cur.depth >= maxDepth) {
      boundary.push(cur.oid);
      continue;
    }
    // With no deepen, a shallow-boundary commit is a leaf: the client holds
    // it but not its history, and did not ask to extend below it.
    if (maxDepth === 0 && shallowSet.has(cur.oid)) continue;
    const obj = get(cur.oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    descended.add(cur.oid);
    for (const p of parseCommit(obj.data).parents) {
      if (!commits.has(p) && get(p)?.type === 'commit') {
        commits.set(p, cur.depth + 1);
        queue.push({ oid: p, depth: cur.depth + 1 });
      }
    }
  }
  const objects: PackEntry[] = [];
  const seen = new Set<string>();
  const addObject = (oid: string): void => {
    if (seen.has(oid) || haveReach.has(oid)) return;
    const obj = get(oid);
    if (obj === undefined) return;
    seen.add(oid);
    objects.push({ type: obj.type, data: obj.data });
  };
  const addTree = (treeOid: string): void => {
    const obj = get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    addObject(treeOid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') addTree(e.oid);
      else addObject(e.oid);
    }
  };
  for (const oid of commits.keys()) {
    addObject(oid);
    const obj = get(oid);
    if (obj !== undefined && obj.type === 'commit') addTree(parseCommit(obj.data).tree);
  }
  // Annotated tags and other non-commit wants ride along with the pack.
  for (const oid of extraWants) addObject(oid);
  // Boundary commits already sent still count as shallow; a boundary commit the client
  // already has (via haves) is not re-sent and stays out of the shallow list.
  // A former shallow commit whose parents this walk followed is unshallow now;
  // a former shallow commit this walk did not extend stays shallow and is
  // re-asserted, so the client keeps it in its shallow file.
  const sentBoundary = boundary.filter((oid) => seen.has(oid));
  const unshallowed = req.shallowLines.filter((oid) => descended.has(oid));
  const stillShallow = req.shallowLines.filter((oid) => !unshallowed.includes(oid));
  const reportedBoundary = [...new Set([...sentBoundary, ...stillShallow])];
  return { commits, objects, boundary: reportedBoundary, unshallowed };
}

/** Common ancestors: haves that are ancestors of a want. */
function commonHaves(repo: Repo, req: FetchRequest): string[] {
  if (req.haves.length === 0) return [];
  const get = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const wantReach = reachable(get, req.wants);
  return req.haves.filter((h) => wantReach.has(h) && get(h) !== undefined);
}

/**
 * The v2 fetch response, following git's own rules (fetch-pack.c):
 *
 * - When the client sent `done`, negotiation is over: the response carries NO
 *   acknowledgments section at all — git goes straight to the packfile section
 *   (a fresh clone sends `done` in its first request, so an acknowledgments
 *   section here makes real git die with "expected 'packfile'").
 * - When the client did NOT send `done` (an open negotiation round), the
 *   response is the acknowledgments section only: NAK + FLUSH when nothing is
 *   in common (the client sends another round), or ACK lines + `ready` +
 *   DELIM when a common commit was found (the packfile follows in this same
 *   response — a DELIM is expected after `ready`, a FLUSH after no `ready`).
 * - The packfile section always follows a `done` request or a `ready` ack,
 *   even when there is nothing new: then it carries a valid empty pack, so the
 *   client sees 0 objects instead of a missing section.
 * Every section ends with a flush packet (a delim belongs in requests only,
 * except for the one after `ready`).
 */
function fetchResponseV2(repo: Repo, req: FetchRequest): Buffer {
  const parts: Buffer[] = [];
  const common = commonHaves(repo, req);
  const walk = walkForFetch(repo, req);
  const hasShallow = walk.boundary.length > 0 || walk.unshallowed.length > 0;

  if (!req.done) {
    parts.push(pktLine('acknowledgments\n'));
    if (common.length === 0) {
      parts.push(pktLine('NAK\n'));
      parts.push(PKT_FLUSH);
      return Buffer.concat(parts);
    }
    for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }

  if (hasShallow) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of walk.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of walk.unshallowed) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  // The packfile section: always present after `done` or `ready`, even empty.
  parts.push(pktLine('packfile\n'));
  const pack = writePack(walk.objects);
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v0 upload-pack response for a parsed want/have request. */
function fetchResponseV0(repo: Repo, req: FetchRequest): Buffer {
  const parts: Buffer[] = [];
  const common = commonHaves(repo, req);
  const walk = walkForFetch(repo, req);
  if (common.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
  }
  for (const oid of walk.boundary) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of walk.unshallowed) parts.push(pktLine(`unshallow ${oid}\n`));
  if (walk.objects.length > 0) {
    const pack = writePack(walk.objects);
    const CHUNK = 65515;
    for (let off = 0; off < pack.length; off += CHUNK) {
      const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** One ls-refs line, or null when the ref is filtered out. */
function lsRefLine(
  repo: Repo,
  name: string,
  oid: string | null,
  prefixes: string[],
  peel: boolean,
): Buffer | null {
  if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) return null;
  if (oid === null) {
    // Unborn ref.
    return pktLine(`unborn ${name} symref-target:refs/heads/main\n`);
  }
  let line = `${oid} ${name}`;
  if (name === 'HEAD') line += ' symref-target:refs/heads/main';
  if (peel) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const targetObj = repo.objects.get(target);
      if (targetObj !== undefined && targetObj.type === 'commit') line += ` peeled:${target}`;
    }
  }
  return pktLine(`${line}\n`);
}

/** The v2 ls-refs response. */
function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const unborn = args.includes('unborn');
  const prefixes: string[] = [];
  for (const a of args) {
    if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const defaultTip = repo.refs.get('refs/heads/main');
  // HEAD first.
  const headLine = lsRefLine(repo, 'HEAD', defaultTip ?? null, prefixes, peel);
  if (headLine !== null) {
    if (defaultTip === undefined && !unborn) {
      // No HEAD line without the unborn argument when the repo has no commits.
    } else {
      parts.push(headLine);
    }
  }
  const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of sorted) {
    const line = lsRefLine(repo, name, oid, prefixes, peel);
    if (line !== null) parts.push(line);
  }
  if (repo.refs.size === 0 && unborn) {
    // Only the HEAD unborn line (already pushed above when unborn was asked).
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack — v2 when Git-Protocol: version=2, else v0. */
export function handleUploadPack(repo: Repo, body: Buffer, version2: boolean): GitHttpResult {
  try {
    const items = parsePktLines(body);
    if (version2) {
      const first = items.find((i) => i.kind === 'line');
      const command = first !== undefined && first.kind === 'line' ? first.data.toString('utf8').trim() : '';
      const args: string[] = [];
      let seenDelim = false;
      for (const item of items) {
        if (item.kind === 'delim') {
          seenDelim = true;
          continue;
        }
        if (item.kind === 'line' && seenDelim) args.push(item.data.toString('utf8').trimEnd());
      }
      if (command === 'command=ls-refs') {
        return okResult('application/x-git-upload-pack-result', lsRefsResponse(repo, args));
      }
      if (command === 'command=fetch') {
        const req = parseFetchArgs(items);
        return okResult('application/x-git-upload-pack-result', fetchResponseV2(repo, req));
      }
      return errResult(400, `unknown upload-pack v2 command ${JSON.stringify(command)}`);
    }
    const req = parseFetchArgs(items);
    return okResult('application/x-git-upload-pack-result', fetchResponseV0(repo, req));
  } catch (e) {
    return errResult(400, e instanceof Error ? e.message : 'malformed upload-pack request');
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack request body into commands + the pack that follows the flush. */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const items = parsePktLines(body);
  const commands: PushCommand[] = [];
  let packStart = body.length;
  let off = 0;
  // Walk the raw buffer to find where the flush pkt-line ends (the pack follows it).
  while (off + 4 <= body.length) {
    const lenText = body.subarray(off, off + 4).toString('utf8');
    if (lenText === '0000') {
      packStart = off + 4;
      break;
    }
    const len = parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > body.length) break;
    const line = body.subarray(off + 4, off + len).toString('utf8');
    const nul = line.indexOf('\0');
    const clean = (nul === -1 ? line : line.slice(0, nul)).trimEnd();
    const parts = clean.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    off += len;
  }
  void items;
  return { commands, pack: body.subarray(packStart) };
}

/** Is `ancestor` reachable from `tip` (any parent chain)? BFS with early exit. */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const get = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const seen = new Set<string>([tip]);
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const obj = get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return false;
}

/** POST /{owner}/{repo}.git/git-receive-pack — v0 with report-status in sideband. */
export function handleReceivePack(repo: Repo, body: Buffer): GitHttpResult {
  try {
    const { commands, pack } = parseReceivePack(body);
    // Report-status lines are pkt-lines nested inside the band-1 payload: the
    // sideband demuxer strips the outer framing and the band byte, and the
    // client then parses the inner pkt-line stream ("unpack ok", "ok <ref>").
    const sideband = (text: string): Buffer =>
      pktLine(Buffer.concat([Buffer.from([1]), pktLine(text)]));
    /** A band-1 packet carrying the inner flush that ends the report stream. */
    const sidebandFlush = (): Buffer =>
      pktLine(Buffer.concat([Buffer.from([1]), Buffer.from('0000', 'utf8')]));
    if (pack.length > 0) {
      try {
        const parsed = parsePack(pack, repo.objects);
        for (let i = 0; i < parsed.entries.length; i += 1) {
          const entry = parsed.entries[i] as PackEntry;
          const oid = parsed.oids[i] as string;
          if (!repo.objects.has(oid)) repo.objects.set(oid, { type: entry.type, data: entry.data });
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : 'unpack failed';
        const out = Buffer.concat([sideband(`unpack ${detail}\n`), sidebandFlush(), PKT_FLUSH]);
        return okResult('application/x-git-receive-pack-result', out);
      }
    }
    const parts: Buffer[] = [sideband('unpack ok\n')];
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let reason: string | null = null;
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reason = 'no such ref';
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) reason = 'non-fast-forward';
      } else if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) reason = 'non-fast-forward';
        else if (!repo.objects.has(cmd.newOid)) reason = 'non-fast-forward';
      } else {
        // Update.
        if (current === undefined) reason = 'non-fast-forward';
        else if (current !== cmd.oldOid) reason = 'non-fast-forward';
        else if (!repo.objects.has(cmd.newOid)) reason = 'non-fast-forward';
        else if (!isAncestor(repo, cmd.oldOid, cmd.newOid) && cmd.oldOid !== cmd.newOid) reason = 'non-fast-forward';
      }
      if (reason !== null) {
        parts.push(sideband(`ng ${cmd.ref} ${reason}\n`));
        continue;
      }
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
      parts.push(sideband(`ok ${cmd.ref}\n`));
    }
    // The inner pkt-line stream ends with its own flush, so the client's
    // report reader sees a clean end instead of EOF mid-packet; the outer
    // flush then ends the sideband stream itself.
    parts.push(sidebandFlush());
    parts.push(PKT_FLUSH);
    return okResult('application/x-git-receive-pack-result', Buffer.concat(parts));
  } catch (e) {
    return errResult(400, e instanceof Error ? e.message : 'malformed receive-pack request');
  }
}

/** The tip a ref name resolves to for ls-refs/advertisement purposes. */
export function refTarget(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export { hashObject, parseCommit, firstParentChain };
export type { GitObjectType };

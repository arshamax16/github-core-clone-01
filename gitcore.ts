// gitcore.ts — the git object model: SHA-1 ids, object parse/build, pack read/write,
// pkt-line framing, reachability walks, tree diffs and three-way merges.
// Pure functions over Buffers and Maps; no I/O, no network. Stdlib only.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** SHA-1 hex of a buffer. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `type` + `data` (SHA-1 over "<type> <size>\0" + data).
 *  Streams the header and data into the hash: no Buffer.concat copy of the data. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialize a commit object (no trailing newline added to the message). */
export function buildCommit(c: CommitData): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

/** Parse a tree object's bytes into entries (already in git's stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const mode = data.subarray(off, sp).toString('utf8');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Compare two tree entries the way git sorts them (directories sort as name + "/"). */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

/** Serialize tree entries in git's sorted order. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tag object's bytes (lightweight: only the fields we need). */
export function parseTag(data: Buffer): { object: string; type: GitObjectType; tag: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line payload (no trailing newline added). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'utf8');
export const PKT_DELIM = Buffer.from('0001', 'utf8');
export const PKT_RESPONSE_END = Buffer.from('0002', 'utf8');

export type PktItem =
  | { kind: 'line'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Split a buffer into pkt-line items; stops at the first malformed length. */
export function parsePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenText = buf.subarray(off, off + 4).toString('utf8');
    if (lenText === '0000') {
      items.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (lenText === '0001') {
      items.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (lenText === '0002') {
      items.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    const len = parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    items.push({ kind: 'line', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return items;
}

// ---------------------------------------------------------------- packs

export interface PackEntry {
  type: GitObjectType;
  data: Buffer;
}

/** Read a varint as git packs encode it (7 bits per byte, low bit first, MSB continues). */
function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f;
  let shift = 7;
  let i = off + 1;
  while (buf[i - 1] & 0x80) {
    value |= (buf[i] & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { value, next: i };
}

/** Adler-32 checksum (the zlib stream's trailing checksum). */
export function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] as number)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Exact byte length of the zlib stream starting at `off`, whose inflated bytes are `data`.
 * Fast path: locate the stream's end by scanning for its Adler-32 trailer — the stream ends
 * right after those 4 bytes. A single verification inflate of the exact slice confirms the
 * length; on any mismatch it falls back to the (slow, throwing) binary search, so correctness
 * never depends on the scan. This replaces ~11 throwing inflate probes per object with 1
 * verification inflate and no exceptions. `data` is the already-inflated stream content
 * (from the caller's single whole-remainder inflate), so the total per object is 2 inflates.
 */
function zlibStreamLengthFor(data: Buffer, buf: Buffer, off: number, limit: number): number {
  const size = data.length;
  // The Adler-32 trailer is the last 4 bytes of the stream; scan for it.
  const ad = adler32(data);
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(ad, 0);
  // A zlib stream is at least 8 bytes (2 header + 2 deflate + 4 adler).
  const at = buf.indexOf(needle, off + 6);
  if (at !== -1 && at + 4 <= limit) {
    const end = at + 4;
    try {
      const check = inflateSync(buf.subarray(off, end));
      if (check.length === size) return end - off;
    } catch {
      // Fall through to the binary search.
    }
  }
  // Slow fallback: binary-search the smallest end that inflates cleanly.
  const bound = Math.min(limit, off + size + Math.floor(size / 1000) * 5 + 64);
  const succeeds = (end: number): boolean => {
    try {
      inflateSync(buf.subarray(off, end));
      return true;
    } catch {
      return false;
    }
  };
  if (!succeeds(bound)) {
    if (!succeeds(limit)) throw new Error('truncated zlib stream in pack');
    let lo = bound;
    let hi = limit;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (succeeds(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo - off;
  }
  let lo = off;
  let hi = bound;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (succeeds(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo - off;
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off];
      off += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const srcSize = readDeltaVarint();
  const dstSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const parts: Buffer[] = [];
  let outLen = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOff |= delta[off] << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= delta[off] << (8 * i);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      outLen += cpSize;
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      outLen += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== dstSize || outLen !== dstSize) throw new Error('delta target size mismatch');
  return out;
}

export interface ParsedPack {
  entries: PackEntry[];
  /** The oids, in pack order, computed from type + data. */
  oids: string[];
}

/** Parse a PACK v2 buffer. `baseObjects` resolves REF/OFS deltas against existing objects. */
export function parsePack(buf: Buffer, baseObjects?: Map<string, GitObject>): ParsedPack {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a PACK file');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported PACK version ${version}`);
  const count = buf.readUInt32BE(8);
  // Trailer check: last 20 bytes must be the SHA-1 of everything before them.
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const computed = sha1Hex(buf.subarray(0, buf.length - 20));
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const entries: PackEntry[] = [];
  const oids: string[] = [];
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer }>();
  let off = 12;
  const typeByCode: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (let n = 0; n < count; n += 1) {
    const entryStart = off;
    const first = buf[off];
    const typeCode = (first >> 4) & 0x7;
    off += 1;
    // Size varint: low 4 bits in the first byte, then 7 bits per byte.
    let size = first & 0x0f;
    let shift = 4;
    while (buf[off - 1] & 0x80) {
      size |= (buf[off] & 0x7f) << shift;
      shift += 7;
      off += 1;
    }
    let type: GitObjectType;
    let data: Buffer;
    if (typeCode === 6) {
      // OFS_DELTA: offset varint, then zlib delta.
      let b = buf[off];
      off += 1;
      let deltaOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[off];
        off += 1;
        deltaOff = ((deltaOff + 1) << 7) | (b & 0x7f);
      }
      const baseOffset = entryStart - deltaOff;
      const base = byOffset.get(baseOffset);
      if (base === undefined) throw new Error('ofs-delta base not found in pack');
      const delta = inflateSync(buf.subarray(off));
      off += zlibStreamLengthFor(delta, buf, off, buf.length - 20);
      data = applyDelta(base.data, delta);
      type = base.type;
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base oid, then zlib delta.
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const delta = inflateSync(buf.subarray(off));
      off += zlibStreamLengthFor(delta, buf, off, buf.length - 20);
      const base = byOffsetOid(baseOid, entries, oids, baseObjects);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} not found`);
      data = applyDelta(base.data, delta);
      type = base.type;
    } else {
      type = typeByCode[typeCode] as GitObjectType;
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      data = inflateSync(buf.subarray(off));
      off += zlibStreamLengthFor(data, buf, off, buf.length - 20);
    }
    if (data.length !== size) throw new Error('pack object size mismatch');
    entries.push({ type, data });
    oids.push(hashObject(type, data));
    byOffset.set(entryStart, { type, data });
  }
  return { entries, oids };
}

function byOffsetOid(
  oid: string,
  entries: PackEntry[],
  oids: string[],
  baseObjects?: Map<string, GitObject>,
): GitObject | undefined {
  const idx = oids.indexOf(oid);
  if (idx !== -1) return entries[idx];
  return baseObjects?.get(oid);
}

/** Serialize objects into a PACK v2 buffer (delta-free). */
export function writePack(objects: PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  const typeCode: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objects) {
    // Level 1: the pack's bytes are checksummed by the client, not size-scored, so
    // the fastest deflate wins (a 1 KiB blob compresses nearly identically at any level).
    const deflated = deflateSync(obj.data, { level: 1 });
    const size = obj.data.length;
    const head: number[] = [];
    let s = size;
    let first = (typeCode[obj.type] << 4) | (s & 0x0f);
    s >>= 4;
    if (s > 0) first |= 0x80;
    head.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>= 7;
      if (s > 0) b |= 0x80;
      head.push(b);
    }
    parts.push(Buffer.from(head));
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- walks

export type ObjectGetter = (oid: string) => GitObject | undefined;

/** All oids reachable from `tips` (commits, their trees/blobs, tag targets), following parents. */
export function reachable(get: ObjectGetter, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** First-parent history of a commit tip, newest first. */
export function firstParentChain(get: ObjectGetter, tip: string): string[] {
  const out: string[] = [];
  let cur: string | undefined = tip;
  const seen = new Set<string>();
  while (cur !== undefined && cur !== ZERO_OID && !seen.has(cur)) {
    seen.add(cur);
    const obj = get(cur);
    if (obj === undefined || obj.type !== 'commit') break;
    out.push(cur);
    cur = parseCommit(obj.data).parents[0];
  }
  return out;
}

/** The merge-base of two tips: the first commit on `a`'s first-parent chain reachable from `b`. */
export function mergeBase(get: ObjectGetter, a: string, b: string): string | null {
  const aChain = firstParentChain(get, a);
  const bReach = reachable(get, [b]);
  for (const oid of aChain) {
    if (bReach.has(oid)) return oid;
  }
  return null;
}

/** The tree entries at a path inside a tree ("" = the root tree itself). */
export function treeAt(get: ObjectGetter, treeOid: string, path: string): TreeEntry[] | null {
  if (path === '' || path === '/') {
    const obj = get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return null;
    return parseTree(obj.data);
  }
  const segments = path.split('/').filter((s) => s !== '');
  let cur = treeOid;
  for (const seg of segments) {
    const obj = get(cur);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg);
    if (entry === undefined || entry.mode !== '40000') return null;
    cur = entry.oid;
  }
  const obj = get(cur);
  if (obj === undefined || obj.type !== 'tree') return null;
  return parseTree(obj.data);
}

/** The blob oid at `path` inside a tree, or null when absent/not a blob. */
export function blobAt(get: ObjectGetter, treeOid: string, path: string): string | null {
  const segments = path.split('/').filter((s) => s !== '');
  let cur = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = get(cur);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? null : entry.oid;
    }
    if (entry.mode !== '40000') return null;
    cur = entry.oid;
  }
  return null;
}

/** A flat map of path -> {mode, oid} for every blob in a tree (recursive). */
export function flattenTree(get: ObjectGetter, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, base: string): void => {
    const obj = get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const p = base === '' ? e.name : `${base}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, p);
      else out.set(p, { mode: e.mode, oid: e.oid });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build a tree object (as entries) with `path` set to `blobOid`, creating dirs as needed. */
export function treeWithPath(
  get: ObjectGetter,
  put: (type: GitObjectType, data: Buffer) => string,
  baseTreeOid: string | null,
  path: string,
  blobOid: string | null,
): string {
  const segments = path.split('/').filter((s) => s !== '');
  const build = (treeOid: string | null, idx: number): string => {
    const entries: TreeEntry[] = treeOid === null ? [] : parseTree(get(treeOid)?.data ?? Buffer.alloc(0));
    const name = segments[idx] as string;
    const kept = entries.filter((e) => e.name !== name);
    if (idx === segments.length - 1) {
      if (blobOid !== null) kept.push({ mode: '100644', name, oid: blobOid });
      // blobOid null = delete the entry.
    } else {
      const existing = entries.find((e) => e.name === name && e.mode === '40000');
      const childOid = build(existing === undefined ? null : existing.oid, idx + 1);
      const childEntries = parseTree(get(childOid)?.data ?? Buffer.alloc(0));
      if (childEntries.length > 0) kept.push({ mode: '40000', name, oid: childOid });
    }
    return put('tree', buildTree(kept));
  };
  return build(baseTreeOid, 0);
}

// ---------------------------------------------------------------- diff / merge

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Line counts of a simple LCS diff between two texts. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // Strip a single trailing empty element produced by a trailing newline.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS via DP; files here are small (blobs are at most a few KB in the suite).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const lcs = dp[0]![0] ?? 0;
  return { additions: m - lcs, deletions: n - lcs };
}

/** The file-level diff between two trees (base -> head). */
export function diffTrees(get: ObjectGetter, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = baseTreeOid === null ? new Map() : flattenTree(get, baseTreeOid);
  const head = headTreeOid === null ? new Map() : flattenTree(get, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === undefined && h !== undefined) {
      const content = get(h.oid)?.data.toString('utf8') ?? '';
      const lines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      out.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions: Math.max(lines, 0), deletions: 0 });
    } else if (b !== undefined && h === undefined) {
      const content = get(b.oid)?.data.toString('utf8') ?? '';
      const lines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      out.push({ path, status: 'removed', oldOid: b.oid, newOid: null, additions: 0, deletions: Math.max(lines, 0) });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldText = get(b.oid)?.data.toString('utf8') ?? '';
      const newText = get(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions, deletions });
    }
  }
  return out;
}

export interface MergeResult {
  ok: boolean;
  /** The merged tree oid (when ok). */
  treeOid: string | null;
  /** Conflicting paths (when not ok). */
  conflicts: string[];
}

/**
 * Three-way merge of `headTree` onto `baseTree` with `ancestorTree` as the base.
 * A file conflicts when both sides changed it differently from the ancestor.
 */
export function threeWayMerge(
  get: ObjectGetter,
  put: (type: GitObjectType, data: Buffer) => string,
  ancestorTreeOid: string | null,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): MergeResult {
  const ancestor = ancestorTreeOid === null ? new Map() : flattenTree(get, ancestorTreeOid);
  const base = baseTreeOid === null ? new Map() : flattenTree(get, baseTreeOid);
  const head = headTreeOid === null ? new Map() : flattenTree(get, headTreeOid);
  const paths = new Set([...ancestor.keys(), ...base.keys(), ...head.keys()]);
  const conflicts: string[] = [];
  const merged = new Map<string, { mode: string; oid: string }>();
  for (const path of paths) {
    const a = ancestor.get(path);
    const b = base.get(path);
    const h = head.get(path);
    const bChanged = (b?.oid ?? null) !== (a?.oid ?? null);
    const hChanged = (h?.oid ?? null) !== (a?.oid ?? null);
    if (hChanged && bChanged) {
      if ((b?.oid ?? null) === (h?.oid ?? null)) {
        if (b !== undefined) merged.set(path, b);
      } else {
        conflicts.push(path);
      }
    } else if (hChanged) {
      if (h !== undefined) merged.set(path, h);
    } else if (b !== undefined) {
      merged.set(path, b);
    }
  }
  if (conflicts.length > 0) return { ok: false, treeOid: null, conflicts };
  // Rebuild nested trees from the flat map.
  const build = (pathsIn: Map<string, { mode: string; oid: string }>, prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
    for (const [p, v] of pathsIn) {
      const rest = prefix === '' ? p : p.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: v.mode, name: rest, oid: v.oid });
      } else {
        const dir = rest.slice(0, slash);
        let sub = dirs.get(dir);
        if (sub === undefined) {
          sub = new Map();
          dirs.set(dir, sub);
        }
        sub.set(p, v);
      }
    }
    for (const [dir, sub] of [...dirs.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      const childOid = build(sub, prefix === '' ? dir : `${prefix}/${dir}`);
      entries.push({ mode: '40000', name: dir, oid: childOid });
    }
    return put('tree', buildTree(entries));
  };
  return { ok: true, treeOid: build(merged, ''), conflicts: [] };
}

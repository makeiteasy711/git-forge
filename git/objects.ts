import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly oid: string;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

export function storeObject(type: GitObjectType, data: Uint8Array): GitObject {
  const buf = Buffer.from(data);
  return { type, data: buf, oid: hashObject(type, buf) };
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(isDirMode(a.mode) ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(isDirMode(b.mode) ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function isDirMode(mode: string): boolean {
  const n = parseInt(mode, 8);
  return (n & 0o170000) === 0o040000 || mode === '40000' || mode === '040000';
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode.replace(/^0+/, '') || '0';
    const name = Buffer.from(entry.name, 'utf8');
    const oid = Buffer.from(entry.oid, 'hex');
    if (oid.length !== 20) throw new Error(`bad tree oid ${entry.oid}`);
    parts.push(Buffer.from(`${mode} `, 'ascii'), name, Buffer.from([0]), oid);
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer?: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer ?? fields.author}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function formatIdentity(name: string, email: string, whenSec = Math.floor(Date.now() / 1000)): string {
  return `${name} <${email}> ${whenSec} +0000`;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean; followParents?: boolean } = {},
): Set<string> {
  const followParents = options.followParents !== false;
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      if (followParents) stack.push(...view.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

export function collectFromCommitNoParents(oid: string, lookup: ObjectLookup): Set<string> {
  const object = lookup(oid);
  if (!object || object.type !== 'commit') return new Set(object ? [oid] : []);
  const seen = new Set<string>([oid]);
  const stack = [parseCommit(object.data).tree];
  while (stack.length) {
    const next = stack.pop()!;
    if (!next || seen.has(next)) continue;
    const obj = lookup(next);
    if (!obj) continue;
    seen.add(next);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  }
  return seen;
}

export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  if (!ancestor || ancestor === ZERO_OID || !descendant || descendant === ZERO_OID) return false;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

export function flattenTree(
  treeOid: string,
  lookup: ObjectLookup,
  prefix = '',
): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const object = lookup(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isDirMode(entry.mode)) {
      for (const [child, value] of flattenTree(entry.oid, lookup, path)) out.set(child, value);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

export function buildTreeFromPaths(
  files: Iterable<[string, { mode: string; oid: string }]>,
  store: (type: GitObjectType, data: Uint8Array) => GitObject,
): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of files) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i]!;
      let child = node.dirs.get(name);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1]!, value);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: write(child) });
    return store('tree', buildTree(entries)).oid;
  };
  return write(root);
}

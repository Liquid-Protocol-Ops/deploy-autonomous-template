import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertAllowed } from './safety/allowlist.js';

// ── Schema types ──────────────────────────────────────────────────────

export type PageType = 'ingested' | 'authored' | 'derived';

export type Tag =
  | 'identity'
  | 'schema'
  | 'soul'
  | 'style'
  | 'influence'
  | 'calibration'
  | 'spec'
  | 'decision'
  | 'memory'
  | 'observation';

export interface SourceEntry {
  url: string;
  cite: string;
}

export interface PageFrontmatter {
  page_type: PageType;
  genesis_lock: boolean;
  created: string;
  updated: string;
  tags: Tag[];
  sources?: SourceEntry[];
  drift_threshold?: number;
}

export interface MemoryPage {
  frontmatter: PageFrontmatter;
  body: string;
}

// ── Errors ────────────────────────────────────────────────────────────

export class SchemaViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaViolation';
  }
}

// ── Validation ────────────────────────────────────────────────────────

const PAGE_TYPES = new Set<string>(['ingested', 'authored', 'derived']);
const VALID_TAGS = new Set<string>([
  'identity', 'schema', 'soul', 'style', 'influence',
  'calibration', 'spec', 'decision', 'memory', 'observation',
]);
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const KNOWN_KEYS = new Set([
  'page_type', 'genesis_lock', 'created', 'updated', 'tags', 'sources', 'drift_threshold',
]);

export function validateFrontmatter(fm: Record<string, unknown>): PageFrontmatter {
  for (const key of Object.keys(fm)) {
    if (!KNOWN_KEYS.has(key)) throw new SchemaViolation(`unknown frontmatter key: ${key}`);
  }

  const { page_type, genesis_lock, created, updated, tags, sources } = fm;

  if (!PAGE_TYPES.has(page_type as string))
    throw new SchemaViolation(`invalid page_type: ${page_type}`);

  if (typeof genesis_lock !== 'boolean')
    throw new SchemaViolation('genesis_lock must be a boolean');

  if (typeof created !== 'string' || !ISO_8601.test(created))
    throw new SchemaViolation(`created must be ISO-8601 UTC: ${created}`);

  if (typeof updated !== 'string' || !ISO_8601.test(updated))
    throw new SchemaViolation(`updated must be ISO-8601 UTC: ${updated}`);

  if (!Array.isArray(tags) || tags.length === 0)
    throw new SchemaViolation('tags must be a non-empty array');

  for (const t of tags as string[]) {
    if (!VALID_TAGS.has(t)) throw new SchemaViolation(`invalid tag: ${t}`);
  }

  if (page_type === 'ingested') {
    if (!Array.isArray(sources) || sources.length === 0)
      throw new SchemaViolation('ingested pages require at least one source');
    for (const s of sources as Record<string, unknown>[]) {
      if (typeof s.url !== 'string' || typeof s.cite !== 'string')
        throw new SchemaViolation('each source must have url (string) and cite (string)');
    }
  } else if (sources !== undefined) {
    throw new SchemaViolation('sources is only allowed on ingested pages');
  }

  const result: PageFrontmatter = {
    page_type: page_type as PageType,
    genesis_lock: genesis_lock as boolean,
    created: created as string,
    updated: updated as string,
    tags: tags as Tag[],
  };

  if (sources !== undefined) result.sources = sources as SourceEntry[];

  const dt = fm.drift_threshold;
  if (dt !== undefined) {
    if (typeof dt !== 'number' || dt < 0 || dt > 1)
      throw new SchemaViolation('drift_threshold must be a number in [0, 1]');
    result.drift_threshold = dt;
  }

  return result;
}

// ── Parsing ───────────────────────────────────────────────────────────

function parseYamlValue(value: string): unknown {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  if (!isNaN(n) && v !== '') return n;
  // Strip optional surrounding quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    return v.slice(1, -1);
  return v;
}

function parseInlineList(raw: string): unknown[] {
  // Handles "[ a, b, c ]" or "[ { url: x, cite: y }, ... ]"
  const inner = raw.trim().slice(1, -1).trim(); // strip [ ]
  if (!inner) return [];

  // If items are objects, split on "}, {" boundary
  if (inner.includes('{')) {
    const items: Record<string, unknown>[] = [];
    const objectParts = inner.split(/},\s*{/);
    for (const part of objectParts) {
      const clean = part.replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim();
      const obj: Record<string, unknown> = {};
      for (const pair of clean.split(',')) {
        const colonIdx = pair.indexOf(':');
        if (colonIdx === -1) continue;
        const k = pair.slice(0, colonIdx).trim();
        const v = pair.slice(colonIdx + 1).trim();
        obj[k] = parseYamlValue(v);
      }
      items.push(obj);
    }
    return items;
  }

  return inner.split(',').map(s => parseYamlValue(s.trim()));
}

export function parsePage(content: string): MemoryPage {
  if (!content.startsWith('---')) throw new SchemaViolation('missing YAML frontmatter block');

  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) throw new SchemaViolation('frontmatter closing --- not found');

  const yamlBlock = content.slice(4, endIdx); // skip opening ---\n
  const body = content.slice(endIdx + 4).replace(/^\n/, ''); // skip closing ---\n

  const raw: Record<string, unknown> = {};
  for (const line of yamlBlock.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (val.startsWith('[')) {
      raw[key] = parseInlineList(val);
    } else {
      raw[key] = parseYamlValue(val);
    }
  }

  const frontmatter = validateFrontmatter(raw);
  return { frontmatter, body };
}

// ── Serialization ─────────────────────────────────────────────────────

function serializeList(arr: unknown[]): string {
  if (arr.length === 0) return '[]';
  if (typeof arr[0] === 'object' && arr[0] !== null) {
    const items = (arr as Record<string, string>[])
      .map(o => `{url: ${o.url}, cite: ${o.cite}}`)
      .join(', ');
    return `[${items}]`;
  }
  return `[${arr.join(', ')}]`;
}

export function serializePage(page: MemoryPage): string {
  const fm = page.frontmatter;
  const lines: string[] = [
    '---',
    `page_type: ${fm.page_type}`,
    `genesis_lock: ${fm.genesis_lock}`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    `tags: ${serializeList(fm.tags)}`,
  ];
  if (fm.sources) lines.push(`sources: ${serializeList(fm.sources)}`);
  if (fm.drift_threshold !== undefined) lines.push(`drift_threshold: ${fm.drift_threshold}`);
  lines.push('---', '');
  if (page.body) lines.push(page.body);
  return lines.join('\n');
}

// ── I/O ───────────────────────────────────────────────────────────────

export function readMemoryPage(path: string): MemoryPage {
  const content = readFileSync(path, 'utf8');
  return parsePage(content);
}

export function writeMemoryPage(path: string, page: MemoryPage): void {
  assertAllowed(path);
  validateFrontmatter(page.frontmatter as unknown as Record<string, unknown>);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializePage(page), 'utf8');
}

#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env['LINT_REPO_ROOT']
  ? resolve(process.env['LINT_REPO_ROOT'])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CONTROLLED_TAGS = new Set([
  'identity', 'schema', 'soul', 'style', 'influence',
  'calibration', 'spec', 'decision', 'memory', 'observation',
]);
const PAGE_TYPES = new Set(['ingested', 'authored', 'derived']);
const QUOTE_WORD_CAP = 25;
const DEFAULT_DRIFT_THRESHOLD = 0.70;

type Frontmatter = {
  page_type?: string;
  genesis_lock?: boolean;
  created?: string;
  updated?: string;
  tags?: string[];
  sources?: { url: string; cite: string }[];
  drift_threshold?: number;
};

type Diagnostic = { file: string; line?: number; rule: string; message: string };

const diagnostics: Diagnostic[] = [];
const isTemplate = (p: string) => p.endsWith('.template');
const placeholder = /^\{\{.*\}\}$/;

function parseFrontmatter(src: string): { fm: Frontmatter; body: string; bodyStartLine: number } {
  if (!src.startsWith('---\n')) return { fm: {}, body: src, bodyStartLine: 1 };
  const end = src.indexOf('\n---\n', 4);
  if (end === -1) return { fm: {}, body: src, bodyStartLine: 1 };
  const yaml = src.slice(4, end);
  const body = src.slice(end + 5);
  const bodyStartLine = yaml.split('\n').length + 2;
  return { fm: parseYaml(yaml), body, bodyStartLine };
}

function parseYaml(yaml: string): Frontmatter {
  const fm: Frontmatter = {};
  const lines = yaml.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.startsWith('#')) { i++; continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1] as keyof Frontmatter;
    const rawValue = (m[2] ?? '').trim();
    if (rawValue === '') {
      // expect a list on subsequent indented lines
      const items: unknown[] = [];
      i++;
      while (i < lines.length && /^\s+-/.test(lines[i] ?? '')) {
        const ln = lines[i] ?? '';
        const item = ln.replace(/^\s*-\s*/, '');
        // object form: "  - url: foo" then "    cite: bar"
        const objMatch = /^([A-Za-z_]+):\s*(.*)$/.exec(item);
        if (objMatch && objMatch[1] && objMatch[2] !== undefined) {
          const obj: Record<string, string> = { [objMatch[1]]: stripQuotes(objMatch[2]) };
          let j = i + 1;
          while (j < lines.length && /^\s{4,}\w/.test(lines[j] ?? '')) {
            const sub = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(lines[j] ?? '');
            if (sub && sub[1] && sub[2] !== undefined) obj[sub[1]] = stripQuotes(sub[2]);
            j++;
          }
          items.push(obj);
          i = j;
        } else {
          items.push(stripQuotes(item));
          i++;
        }
      }
      (fm as Record<string, unknown>)[key] = items;
      continue;
    }
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1);
      (fm as Record<string, unknown>)[key] = inner.split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
    } else if (rawValue === 'true' || rawValue === 'false') {
      (fm as Record<string, unknown>)[key] = rawValue === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      (fm as Record<string, unknown>)[key] = Number(rawValue);
    } else {
      (fm as Record<string, unknown>)[key] = stripQuotes(rawValue);
    }
    i++;
  }
  return fm;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function isPlaceholder(v: unknown): boolean {
  return typeof v === 'string' && placeholder.test(v);
}

function isIso8601(v: unknown): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v);
}

function listMarkdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const st = statSync(full);
    if (st.isDirectory()) listMarkdownFiles(full, out);
    else if (entry.endsWith('.md') || entry.endsWith('.md.template')) out.push(full);
  }
  return out;
}

function lintFrontmatter(file: string, fm: Frontmatter, isTpl: boolean): void {
  const rel = relative(REPO_ROOT, file);
  const required = ['page_type', 'genesis_lock', 'created', 'updated', 'tags'] as const;
  for (const k of required) {
    if (fm[k] === undefined) diagnostics.push({ file: rel, rule: 'frontmatter.required', message: `missing required key: ${k}` });
  }
  if (fm.page_type !== undefined && !PAGE_TYPES.has(String(fm.page_type))) {
    diagnostics.push({ file: rel, rule: 'frontmatter.page_type', message: `invalid page_type: ${fm.page_type}` });
  }
  if (typeof fm.genesis_lock !== 'boolean' && fm.genesis_lock !== undefined) {
    diagnostics.push({ file: rel, rule: 'frontmatter.genesis_lock', message: 'genesis_lock must be true or false' });
  }
  for (const dateKey of ['created', 'updated'] as const) {
    const v = fm[dateKey];
    if (v !== undefined && !isPlaceholder(v) && !isIso8601(v)) {
      diagnostics.push({ file: rel, rule: 'frontmatter.date', message: `${dateKey} must be ISO-8601 UTC: ${v}` });
    }
  }
  if (Array.isArray(fm.tags)) {
    if (fm.tags.length === 0) diagnostics.push({ file: rel, rule: 'frontmatter.tags', message: 'tags must be non-empty' });
    for (const tag of fm.tags) {
      if (!CONTROLLED_TAGS.has(String(tag))) {
        diagnostics.push({ file: rel, rule: 'frontmatter.tags', message: `unknown tag: ${tag} (see identity/SCHEMA#controlled-tags)` });
      }
    }
  }
  if (fm.page_type === 'ingested' && !Array.isArray(fm.sources)) {
    diagnostics.push({ file: rel, rule: 'frontmatter.sources', message: 'sources required when page_type=ingested' });
  }
  if (fm.page_type !== 'ingested' && fm.sources !== undefined) {
    diagnostics.push({ file: rel, rule: 'frontmatter.sources', message: 'sources only valid when page_type=ingested' });
  }
  const isGenesis = file.includes('.genesis.md');
  if (isGenesis && fm.drift_threshold === undefined) {
    diagnostics.push({ file: rel, rule: 'frontmatter.drift_threshold', message: 'drift_threshold required on .genesis files' });
  }
  if (fm.drift_threshold !== undefined && !isPlaceholder(fm.drift_threshold) && (typeof fm.drift_threshold !== 'number' || fm.drift_threshold < 0 || fm.drift_threshold > 1)) {
    diagnostics.push({ file: rel, rule: 'frontmatter.drift_threshold', message: 'drift_threshold must be in [0, 1]' });
  }
  if (!isGenesis && !isTpl && fm.drift_threshold !== undefined) {
    diagnostics.push({ file: rel, rule: 'frontmatter.drift_threshold', message: 'drift_threshold only valid on .genesis files' });
  }
}

function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, '');
}

function lintBody(file: string, body: string, bodyStartLine: number): void {
  const rel = relative(REPO_ROOT, file);
  const lines = body.split('\n');
  let blockStart = -1;
  let blockText = '';
  const flush = () => {
    if (blockStart === -1) return;
    const words = blockText.trim().split(/\s+/).filter(Boolean);
    if (words.length > QUOTE_WORD_CAP) {
      diagnostics.push({ file: rel, line: bodyStartLine + blockStart, rule: 'body.quote_cap', message: `blockquote has ${words.length} words (>${QUOTE_WORD_CAP})` });
    }
    blockStart = -1;
    blockText = '';
  };
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? '';
    if (/^```/.test(ln)) { inFence = !inFence; flush(); continue; }
    if (inFence) continue;
    // Quote cap
    if (ln.startsWith('>')) {
      if (blockStart === -1) blockStart = i;
      blockText += ' ' + ln.replace(/^>\s?/, '');
    } else {
      flush();
    }
    // Internal links (skip inline code spans)
    const stripped = stripInlineCode(ln);
    const matches = stripped.matchAll(/\[\[([^\]]+)\]\]/g);
    for (const m of matches) {
      const raw = (m[1] ?? '').split('#')[0]?.trim() ?? '';
      if (!raw) continue;
      // Skip placeholders / pattern docs (any-letter) like [[link]], [[path/to/page]], [[...]]
      if (/[^A-Za-z0-9_./-]/.test(raw) || raw === 'link' || raw === 'path/to/page' || raw === '...') continue;
      const candidates = [
        join(REPO_ROOT, `${raw}.md`),
        join(REPO_ROOT, `${raw}.md.template`),
        join(REPO_ROOT, raw),
        join(REPO_ROOT, `${raw}.ts`),
      ];
      if (!candidates.some(p => existsSync(p))) {
        diagnostics.push({ file: rel, line: bodyStartLine + i, rule: 'body.broken_link', message: `broken internal link: [[${m[1]}]]` });
      }
    }
  }
  flush();
}

function tokenize(s: string): Set<string> {
  const tokens = s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 1 : intersect / union;
}

function findDriftPair(stem: 'SOUL' | 'STYLE'): { genesis: string; mutable: string } | null {
  const base = join(REPO_ROOT, 'identity');
  const gMd = join(base, `${stem}.genesis.md`);
  const mMd = join(base, `${stem}.md`);
  const gTpl = join(base, `${stem}.genesis.md.template`);
  const mTpl = join(base, `${stem}.md.template`);
  if (existsSync(gMd) && existsSync(mMd)) return { genesis: gMd, mutable: mMd };
  if (existsSync(gTpl) && existsSync(mTpl)) return { genesis: gTpl, mutable: mTpl };
  return null;
}

function lintDrift(stem: 'SOUL' | 'STYLE'): void {
  const pair = findDriftPair(stem);
  if (!pair) {
    diagnostics.push({ file: `identity/${stem}.md`, rule: 'drift.missing_pair', message: `no genesis+mutable pair found for ${stem}` });
    return;
  }
  const gSrc = readFileSync(pair.genesis, 'utf8');
  const mSrc = readFileSync(pair.mutable, 'utf8');
  const { fm: gFm, body: gBody } = parseFrontmatter(gSrc);
  const { body: mBody } = parseFrontmatter(mSrc);
  const threshold = (typeof gFm.drift_threshold === 'number') ? gFm.drift_threshold : DEFAULT_DRIFT_THRESHOLD;
  const score = jaccard(tokenize(gBody), tokenize(mBody));
  const rel = relative(REPO_ROOT, pair.mutable);
  const isTpl = pair.genesis.endsWith('.template');
  if (isTpl) {
    // Template-mode advisory: templates ship as different bodies (genesis is
    // explanatory prose for the deployer; mutable is bare placeholders). At
    // deploy time they substitute to identical content, so the meaningful
    // drift check is post-substitution. Log the template-mode score and skip
    // the threshold gate.
    process.stderr.write(`drift: ${stem} (template-mode) similarity ${score.toFixed(3)} — gate skipped\n`);
    return;
  }
  if (score < threshold) {
    diagnostics.push({ file: rel, rule: 'drift.threshold', message: `${stem} similarity ${score.toFixed(3)} < threshold ${threshold}` });
  } else {
    process.stderr.write(`drift: ${stem} similarity ${score.toFixed(3)} >= ${threshold} OK\n`);
  }
}

function main(): void {
  const roots = ['identity', 'SECTION_5.md', 'ARCHITECTURE_v2.md'].map(p => join(REPO_ROOT, p));
  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (statSync(root).isDirectory()) listMarkdownFiles(root, files);
    else files.push(root);
  }
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const { fm, body, bodyStartLine } = parseFrontmatter(src);
    lintFrontmatter(file, fm, isTemplate(file));
    lintBody(file, body, bodyStartLine);
  }
  lintDrift('SOUL');
  lintDrift('STYLE');
  if (diagnostics.length === 0) {
    process.stderr.write(`lint-identity: ${files.length} files OK\n`);
    process.exit(0);
  }
  for (const d of diagnostics) {
    const loc = d.line ? `${d.file}:${d.line}` : d.file;
    process.stderr.write(`${loc}  [${d.rule}]  ${d.message}\n`);
  }
  process.stderr.write(`lint-identity: ${diagnostics.length} diagnostic(s)\n`);
  process.exit(1);
}

main();

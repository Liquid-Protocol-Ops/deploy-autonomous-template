import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  validateFrontmatter,
  parsePage,
  serializePage,
  readMemoryPage,
  writeMemoryPage,
  SchemaViolation,
  type MemoryPage,
} from '../memory-io.js';
import { AllowlistViolation } from '../safety/allowlist.js';
import { existsSync, unlinkSync } from 'node:fs';

// ── validateFrontmatter ───────────────────────────────────────────────

describe('validateFrontmatter', () => {
  const base = {
    page_type: 'authored',
    genesis_lock: false,
    created: '2026-05-01T00:00:00Z',
    updated: '2026-05-01T00:00:00Z',
    tags: ['memory'],
  };

  it('accepts a minimal valid authored page', () => {
    const fm = validateFrontmatter(base);
    expect(fm.page_type).toBe('authored');
    expect(fm.genesis_lock).toBe(false);
    expect(fm.tags).toEqual(['memory']);
  });

  it('accepts derived page type', () => {
    expect(() => validateFrontmatter({ ...base, page_type: 'derived' })).not.toThrow();
  });

  it('accepts ingested page with sources', () => {
    const fm = validateFrontmatter({
      ...base,
      page_type: 'ingested',
      sources: [{ url: 'https://example.com', cite: 'Author. 2026.' }],
    });
    expect(fm.sources).toHaveLength(1);
  });

  it('rejects unknown page_type', () => {
    expect(() => validateFrontmatter({ ...base, page_type: 'unknown' })).toThrow(SchemaViolation);
  });

  it('rejects non-boolean genesis_lock', () => {
    expect(() => validateFrontmatter({ ...base, genesis_lock: 'true' })).toThrow(SchemaViolation);
  });

  it('rejects non-ISO-8601 created date', () => {
    expect(() => validateFrontmatter({ ...base, created: '2026-05-01' })).toThrow(SchemaViolation);
  });

  it('rejects non-ISO-8601 updated date', () => {
    expect(() => validateFrontmatter({ ...base, updated: 'yesterday' })).toThrow(SchemaViolation);
  });

  it('rejects empty tags array', () => {
    expect(() => validateFrontmatter({ ...base, tags: [] })).toThrow(SchemaViolation);
  });

  it('rejects an invalid tag', () => {
    expect(() => validateFrontmatter({ ...base, tags: ['memory', 'rogue-tag'] })).toThrow(SchemaViolation);
  });

  it('rejects ingested page without sources', () => {
    expect(() => validateFrontmatter({ ...base, page_type: 'ingested' })).toThrow(SchemaViolation);
  });

  it('rejects ingested page with empty sources', () => {
    expect(() =>
      validateFrontmatter({ ...base, page_type: 'ingested', sources: [] }),
    ).toThrow(SchemaViolation);
  });

  it('rejects authored page with sources present', () => {
    expect(() =>
      validateFrontmatter({ ...base, sources: [{ url: 'https://example.com', cite: 'x' }] }),
    ).toThrow(SchemaViolation);
  });

  it('rejects source entry missing url', () => {
    expect(() =>
      validateFrontmatter({
        ...base,
        page_type: 'ingested',
        sources: [{ cite: 'Author 2026' }],
      }),
    ).toThrow(SchemaViolation);
  });

  it('rejects unknown frontmatter key', () => {
    expect(() => validateFrontmatter({ ...base, custom_field: 'oops' })).toThrow(SchemaViolation);
  });

  it('accepts drift_threshold in [0, 1]', () => {
    const fm = validateFrontmatter({ ...base, drift_threshold: 0.7 });
    expect(fm.drift_threshold).toBe(0.7);
  });

  it('rejects drift_threshold out of range', () => {
    expect(() => validateFrontmatter({ ...base, drift_threshold: 1.5 })).toThrow(SchemaViolation);
    expect(() => validateFrontmatter({ ...base, drift_threshold: -0.1 })).toThrow(SchemaViolation);
  });
});

// ── parsePage ─────────────────────────────────────────────────────────

const VALID_PAGE = `---
page_type: authored
genesis_lock: false
created: 2026-05-01T00:00:00Z
updated: 2026-05-01T00:00:00Z
tags: [memory]
---

# My memory

Some notes here.
`;

describe('parsePage', () => {
  it('round-trips a valid authored page', () => {
    const page = parsePage(VALID_PAGE);
    expect(page.frontmatter.page_type).toBe('authored');
    expect(page.frontmatter.tags).toEqual(['memory']);
    expect(page.body).toContain('# My memory');
  });

  it('parses an ingested page with sources', () => {
    const content = `---
page_type: ingested
genesis_lock: false
created: 2026-05-01T00:00:00Z
updated: 2026-05-01T00:00:00Z
tags: [memory]
sources: [{url: https://example.com, cite: Author 2026}]
---

Body text.
`;
    const page = parsePage(content);
    const sources = page.frontmatter.sources ?? [];
    expect(sources).toHaveLength(1);
    expect(sources.at(0)?.url).toBe('https://example.com');
  });

  it('throws SchemaViolation when frontmatter is missing', () => {
    expect(() => parsePage('# No frontmatter\n')).toThrow(SchemaViolation);
  });

  it('throws SchemaViolation when closing --- is absent', () => {
    expect(() => parsePage('---\npage_type: authored\n')).toThrow(SchemaViolation);
  });

  it('throws SchemaViolation when page_type is invalid', () => {
    const bad = VALID_PAGE.replace('page_type: authored', 'page_type: bogus');
    expect(() => parsePage(bad)).toThrow(SchemaViolation);
  });
});

// ── serializePage ─────────────────────────────────────────────────────

describe('serializePage', () => {
  it('produces parseable output for a simple authored page', () => {
    const page: MemoryPage = {
      frontmatter: {
        page_type: 'authored',
        genesis_lock: false,
        created: '2026-05-01T00:00:00Z',
        updated: '2026-05-01T00:00:00Z',
        tags: ['memory'],
      },
      body: '# Hello\n\nContent.',
    };
    const serialized = serializePage(page);
    const reparsed = parsePage(serialized);
    expect(reparsed.frontmatter).toEqual(page.frontmatter);
    expect(reparsed.body.trim()).toBe(page.body.trim());
  });

  it('round-trips an ingested page with sources', () => {
    const page: MemoryPage = {
      frontmatter: {
        page_type: 'ingested',
        genesis_lock: false,
        created: '2026-05-01T00:00:00Z',
        updated: '2026-05-01T00:00:00Z',
        tags: ['memory'],
        sources: [{ url: 'https://example.com', cite: 'Author 2026' }],
      },
      body: 'Ingested content.',
    };
    const reparsed = parsePage(serializePage(page));
    expect(reparsed.frontmatter.sources).toEqual(page.frontmatter.sources);
  });
});

// ── readMemoryPage / writeMemoryPage ──────────────────────────────────

const validPage: MemoryPage = {
  frontmatter: {
    page_type: 'authored',
    genesis_lock: false,
    created: '2026-05-01T00:00:00Z',
    updated: '2026-05-02T00:00:00Z',
    tags: ['memory'],
  },
  body: '# Roundtrip\n\nThis should survive the round-trip.',
};

describe('writeMemoryPage', () => {
  it('throws AllowlistViolation for a disallowed path', () => {
    expect(() => writeMemoryPage('harness/tick.ts', validPage)).toThrow(AllowlistViolation);
  });

  it('throws SchemaViolation before writing when frontmatter is invalid', () => {
    const badPage: MemoryPage = {
      frontmatter: { ...validPage.frontmatter, page_type: 'bogus' as never },
      body: 'x',
    };
    expect(() => writeMemoryPage('memory/test-schema-check.md', badPage)).toThrow(SchemaViolation);
  });
});

describe('readMemoryPage + writeMemoryPage round-trip', () => {
  const tmpPath = 'memory/test-tmp-spec.md';

  afterEach(() => {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  });

  it('reads back what was written', () => {
    writeMemoryPage(tmpPath, validPage);
    const read = readMemoryPage(tmpPath);
    expect(read.frontmatter).toEqual(validPage.frontmatter);
    expect(read.body.trim()).toBe(validPage.body.trim());
  });
});

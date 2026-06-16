import { describe, expect, it } from 'vitest';
import { chunk, escapeHtml, stripHtml } from '../formatters.js';

describe('escapeHtml', () => {
  it('escapes & < >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('escapes & first so re-escaping does not happen', () => {
    expect(escapeHtml('&lt; tag')).toBe('&amp;lt; tag');
  });
});

describe('chunk', () => {
  it('returns the input as a single chunk when under the limit', () => {
    expect(chunk('hello', 100)).toEqual(['hello']);
  });

  it('returns one empty chunk for empty input', () => {
    expect(chunk('', 100)).toEqual(['']);
  });

  it('prefers paragraph boundaries', () => {
    const para1 = 'a'.repeat(50);
    const para2 = 'b'.repeat(50);
    const text = `${para1}\n\n${para2}`;
    const out = chunk(text, 60);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(para1);
    expect(out[1]).toBe(para2);
  });

  it('falls back to single newline when no paragraph break fits', () => {
    const line1 = 'a'.repeat(40);
    const line2 = 'b'.repeat(40);
    const text = `${line1}\n${line2}`;
    const out = chunk(text, 50);
    expect(out).toEqual([line1, line2]);
  });

  it('hard-cuts mid-paragraph when no newline / space found', () => {
    const text = 'x'.repeat(120); // no whitespace
    const out = chunk(text, 50);
    expect(out).toHaveLength(3);
    expect(out[0]).toHaveLength(50);
    expect(out[1]).toHaveLength(50);
    expect(out[2]).toHaveLength(20);
  });

  it('caps at Telegram hard limit of 4096 regardless of requested cap', () => {
    const text = 'x'.repeat(5000);
    const out = chunk(text, 9999); // requested higher than hard limit
    expect(out.every((c) => c.length <= 4096)).toBe(true);
  });

  it('does not leave stray whitespace at chunk boundaries', () => {
    const text = 'hello world\n\nfoo bar';
    const out = chunk(text, 13);
    for (const piece of out) {
      expect(piece).toBe(piece.trim());
    }
  });
});

describe('stripHtml', () => {
  it('strips simple tags', () => {
    expect(stripHtml('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
  });

  it('unescapes encoded entities', () => {
    expect(stripHtml('&amp; &lt; &gt;')).toBe('& < >');
  });

  it('survives tags with attributes', () => {
    expect(stripHtml('<a href="https://example.com">link</a>')).toBe('link');
  });

  it('does not double-unescape (&amp;lt; stays literal &lt;)', () => {
    expect(stripHtml('&amp;lt;')).toBe('&lt;');
  });

  it('strips nested tags', () => {
    expect(stripHtml('<b><i>hi</i></b>')).toBe('hi');
  });
});

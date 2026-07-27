import { describe, expect, it } from 'vitest';
import { JsonEngine, collectUnsafeIntegers, stringifyWithinLimit } from '../../src/worker/jsonEngine.js';

describe('JsonEngine', () => {
  it('serializes only containers that fit the inline-copy budget', () => {
    expect(stringifyWithinLimit({ small: ['a', 1, true] })).toBe('{"small":["a",1,true]}');
    expect(stringifyWithinLimit({ payload: 'x'.repeat(1_000_000) })).toBeUndefined();
    expect(JsonEngine.parse(JSON.stringify({ payload: 'x'.repeat(1_000_000) })).summary().raw).toBeUndefined();
  });

  it('parses a BOM, pages children lazily, and preserves unsafe integer lexemes', () => {
    const values = Array.from({ length: 450 }, (_, index) => index);
    const text = `\ufeff{"unsafe":900719925474099312345,"values":${JSON.stringify(values)}}`;
    const engine = JsonEngine.parse(text);
    expect(engine.summary().childCount).toBe(2);
    expect(JsonEngine.parse('{"a":1}').summary().raw).toBe('{"a":1}');
    expect(engine.children('/values', 0, 999).children).toHaveLength(200);
    expect(engine.children('/values', 200, 200).children).toHaveLength(200);
    expect(engine.children('/values', 400, 200).children).toHaveLength(50);
    expect(engine.summary('/unsafe', 'unsafe').raw).toBe('900719925474099312345');
  });

  it('locates a distant array child without walking earlier pages and caps payloads', () => {
    const values = Array.from({ length: 100_000 }, (_, index) => index);
    const engine = JsonEngine.parse(JSON.stringify({ values }));
    const page = engine.childPage('/values', '/values/99999', 200);
    expect(page.offset).toBe(99_800);
    expect(page.children[0]?.key).toBe('99800');
    expect(page.children).toHaveLength(200);

    const large = JsonEngine.parse(JSON.stringify({ values: Array.from({ length: 200 }, () => 'x'.repeat(16_384)) }));
    const largePage = large.children('/values', 0, 200);
    expect(Buffer.byteLength(JSON.stringify(largePage), 'utf8')).toBeLessThanOrEqual(900 * 1024);
    expect(largePage.children).toHaveLength(200);
  });

  it('retains exact integers at escaped pointers', () => {
    const values = collectUnsafeIntegers('{"a/b":{"~key":-90071992547409930001,"exponent":9007199254740993e0},"shortExponent":9e18,"safe":9007199254740991}');
    expect(values.get('/a~1b/~0key')).toBe('-90071992547409930001');
    expect(values.get('/a~1b/exponent')).toBe('9007199254740993e0');
    expect(values.get('/shortExponent')).toBe('9e18');
    expect(values.has('/safe')).toBe(false);
  });

  it('can collect one exact number without retaining other numeric lexemes', () => {
    const values = collectUnsafeIntegers('{"first":900719925474099312345,"target":900719925474099312346}', '/target');
    expect([...values.keys()]).toEqual(['/target']);
    expect(values.get('/target')).toBe('900719925474099312346');
  });

  it('does not retain an unsafe lexeme shadowed by a later safe duplicate', () => {
    const values = collectUnsafeIntegers('{"id":900719925474099312345,"id":2}');
    expect(values.has('/id')).toBe(false);
  });

  it('locates editable source nodes without retaining source for large-file engines', () => {
    const source = '\ufeff{\n  "outer": {"value": 1}\n}';
    const editable = JsonEngine.parse(source, true);
    expect(editable.location('/outer/value').offset).toBe(source.indexOf('1'));
    expect(() => JsonEngine.parse(source).location('/outer')).toThrow(/editable files only/);
  });

  it('locates the last duplicate key, matching JSON.parse semantics', () => {
    const source = '{"value":1,"value":2}';
    const engine = JsonEngine.parse(source, true);
    expect(engine.summary('/value', 'value').preview).toBe('2');
    expect(engine.location('/value').offset).toBe(source.lastIndexOf('2'));
  });

  it('searches keys and values asynchronously', async () => {
    const engine = JsonEngine.parse(JSON.stringify({ alpha: 'needle', nested: [{ beta: 'Needle two' }] }));
    const result = await engine.search('needle', 10, () => false);
    expect(result.matches.map((match) => match.pointer)).toEqual(['/alpha', '/nested/0/beta']);
    expect(result.visited).toBeGreaterThan(2);
  });

  it('yields often enough for a cancellation flag to interrupt a deep search', async () => {
    const text = `{"rows":[${Array.from({ length: 100_000 }, (_, index) => `{"id":${index}}`).join(',')}]}`;
    const engine = JsonEngine.parse(text);
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 0);
    await expect(engine.search('not-present', 10, () => cancelled)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('reports invalid JSON and missing pointers', () => {
    expect(() => JsonEngine.parse('{oops')).toThrow(/Unexpected token|Expected property/);
    const engine = JsonEngine.parse('{}');
    expect(() => engine.children('/missing', 0, 10)).toThrow(/does not exist/);
  });
});

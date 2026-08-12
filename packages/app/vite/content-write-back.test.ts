import { CONTENT_FILE_SCHEMAS, RAW_CONTENT } from '@printhead/core';
import { describe, expect, it } from 'vitest';
import { isWritableContentFile, validateWrite } from './content-write-back.js';

/**
 * The dev write-back endpoint (spec §14). It hands the repository's own content
 * files to a browser, so the two things worth proving are that it only ever
 * writes files the schema map names, and that nothing invalid reaches disk.
 */
describe('isWritableContentFile', () => {
  it('accepts exactly the files the schema map knows', () => {
    expect(isWritableContentFile(CONTENT_FILE_SCHEMAS, 'pacing')).toBe(true);
    expect(isWritableContentFile(CONTENT_FILE_SCHEMAS, 'failure')).toBe(true);
    expect(isWritableContentFile(CONTENT_FILE_SCHEMAS, 'nope')).toBe(false);
  });

  it('is not a path — traversal is simply an unknown file', () => {
    expect(isWritableContentFile(CONTENT_FILE_SCHEMAS, '../../package')).toBe(false);
    expect(isWritableContentFile(CONTENT_FILE_SCHEMAS, '/etc/passwd')).toBe(false);
    expect(isWritableContentFile(CONTENT_FILE_SCHEMAS, 'pacing/../../secrets')).toBe(false);
  });

  it('does not inherit a name from Object.prototype', () => {
    expect(isWritableContentFile(CONTENT_FILE_SCHEMAS, 'toString')).toBe(false);
    expect(isWritableContentFile(CONTENT_FILE_SCHEMAS, 'constructor')).toBe(false);
  });
});

describe('validateWrite', () => {
  it('accepts a file that still matches its schema', () => {
    const outcome = validateWrite(CONTENT_FILE_SCHEMAS, 'pacing', RAW_CONTENT.pacing);
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ ok: true, message: 'wrote pacing.json' });
  });

  it('404s an unknown file rather than writing it somewhere', () => {
    expect(validateWrite(CONTENT_FILE_SCHEMAS, '../evil', {}).status).toBe(404);
  });

  it('422s content the schema rejects, naming the field', () => {
    const broken = { ...(RAW_CONTENT.pacing as object), targetHours: -1 };
    const outcome = validateWrite(CONTENT_FILE_SCHEMAS, 'pacing', broken);
    expect(outcome.status).toBe(422);
    expect(outcome.body.ok).toBe(false);
    expect(outcome.body.message).toContain('targetHours');
  });

  it('422s an unknown field — the schemas are strict for a reason', () => {
    const typo = { ...(RAW_CONTENT.pacing as object), targetHrs: 8 };
    expect(validateWrite(CONTENT_FILE_SCHEMAS, 'pacing', typo).status).toBe(422);
  });

  it('422s a payload of entirely the wrong shape', () => {
    expect(validateWrite(CONTENT_FILE_SCHEMAS, 'materials', { not: 'an array' }).status).toBe(422);
    expect(validateWrite(CONTENT_FILE_SCHEMAS, 'pacing', null).status).toBe(422);
  });
});

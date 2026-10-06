import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationValue } from '@starter/nest-support/configuration';

test('file credentials preserve content and fail closed without exposing secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'credentials-'));
  const file = join(directory, 'password');
  try {
    writeFileSync(file, '  private:$value\n');
    expect(configurationValue('PASSWORD', { PASSWORD_FILE: file })).toBe(
      '  private:$value',
    );
    expect(configurationValue('PASSWORD', { PASSWORD: 'direct' })).toBe(
      'direct',
    );
    expect(() =>
      configurationValue('PASSWORD', {
        PASSWORD: 'secret',
        PASSWORD_FILE: file,
      }),
    ).toThrow('Choose PASSWORD or PASSWORD_FILE');
    expect(() =>
      configurationValue('PASSWORD', {
        PASSWORD_FILE: join(directory, 'absent'),
      }),
    ).toThrow('Cannot read PASSWORD_FILE');
    writeFileSync(file, '');
    expect(() =>
      configurationValue('PASSWORD', { PASSWORD_FILE: file }),
    ).toThrow('Empty PASSWORD_FILE');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

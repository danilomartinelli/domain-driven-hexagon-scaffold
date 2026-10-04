import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

interface Identity {
  displayName: string;
  packageName: string;
  author: string;
  owner: string;
  repository: string;
  contact: string;
}

interface Edit {
  line: number;
  before: string;
  after: string;
}

interface FileChange {
  path: string;
  original: string;
  updated: string;
  edits: Edit[];
}

const help = `Usage: bun run rename -- [--apply] \\
  --display-name="Acme Service" --package-name=acme-service \\
  --author="Acme Engineering" --owner=acme --repository=acme/service \\
  --contact=https://github.com/acme

Default: preview exact edits as JSON without writing. --apply writes those edits.
Run at the checkout root. See docs/adoption.md for the bounded file list.
No branches, directories, Git remotes or hosted repositories are renamed.`;

function validateIdentity(value: unknown): Identity {
  if (typeof value !== 'object' || value === null)
    throw new Error('Identity must be an object.');
  const patterns = {
    displayName: /^[\p{L}\p{N}][\p{L}\p{N} .&'-]{0,99}$/u,
    packageName: /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
    author: /^[\p{L}\p{N}][\p{L}\p{N} .&'-]{0,99}$/u,
    owner: /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\/[a-z\d]+(?:-[a-z\d]+)*)?$/i,
    repository: /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]+$/i,
    contact:
      /^(?:https:\/\/[a-z\d][a-z\d./_~@%?=&+#:-]*|mailto:[a-z\d._%+-]+@[a-z\d.-]+\.[a-z]{2,})$/i,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const field: unknown = Reflect.get(value, key);
    if (
      typeof field !== 'string' ||
      field.trim() !== field ||
      !pattern.test(field) ||
      field.length > 214
    )
      throw new Error(
        `Invalid identity field: ${key}. See --help and docs/adoption.md.`,
      );
  }
  return value as Identity;
}

async function planRename(root: string, next: Identity): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  // Refuse links before planning any writes, including links in parent directories.
  async function read(path: string): Promise<string> {
    const absolute = join(root, path);
    if (
      !(await lstat(absolute)).isFile() ||
      (await realpath(dirname(absolute))) !== dirname(absolute)
    )
      throw new Error(
        `Identity surface must be a regular file inside this checkout: ${path}`,
      );
    return readFile(absolute, 'utf8');
  }
  const identityText = await read('scaffold.identity.json');
  const previous = validateIdentity(JSON.parse(identityText));
  const repository = (identity: Identity): string =>
    `https://github.com/${identity.repository}`;
  const anchor = (name: string): string =>
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, '')
      .replaceAll(' ', '-');

  async function edit(
    path: string,
    replacements: [string, string][],
  ): Promise<void> {
    const original = await read(path);
    let updated = original;
    const edits: Edit[] = [];
    for (const [before, after] of replacements) {
      const position = updated.indexOf(before);
      if (
        position < 0 ||
        updated.indexOf(before, position + before.length) >= 0
      )
        throw new Error(
          `Expected one identity fragment in ${path}: ${JSON.stringify(before)}. No files written.`,
        );
      if (before === after) continue;
      edits.push({
        line: updated.slice(0, position).split('\n').length,
        before,
        after,
      });
      updated =
        updated.slice(0, position) +
        after +
        updated.slice(position + before.length);
    }
    if (edits.length > 0) changes.push({ path, original, updated, edits });
  }

  const field = (
    key: string,
    before: string,
    after: string,
  ): [string, string] => [
    `${JSON.stringify(key)}: ${JSON.stringify(before)}`,
    `${JSON.stringify(key)}: ${JSON.stringify(after)}`,
  ];
  await edit(
    'scaffold.identity.json',
    (Object.keys(previous) as (keyof Identity)[]).map((key) =>
      field(key, previous[key], next[key]),
    ),
  );
  await edit('package.json', [
    field('name', previous.packageName, next.packageName),
    field('author', previous.author, next.author),
    field('repository', repository(previous), repository(next)),
    field(
      'homepage',
      `${repository(previous)}#readme`,
      `${repository(next)}#readme`,
    ),
    field(
      'url',
      `${repository(previous)}/issues`,
      `${repository(next)}/issues`,
    ),
  ]);
  await edit('bun.lock', [
    [
      `"": {\n      "name": ${JSON.stringify(previous.packageName)},`,
      `"": {\n      "name": ${JSON.stringify(next.packageName)},`,
    ],
  ]);
  for (const path of ['README.md', 'README.pt-BR.md']) {
    await edit(path, [
      [`# ${previous.displayName}\n`, `# ${next.displayName}\n`],
      [
        `- [${previous.displayName}](#${anchor(previous.displayName)})`,
        `- [${next.displayName}](#${anchor(next.displayName)})`,
      ],
      [
        `[![CI](${repository(previous)}/actions/workflows/ci.yml/badge.svg?branch=master)](${repository(previous)}/actions/workflows/ci.yml)`,
        `[![CI](${repository(next)}/actions/workflows/ci.yml/badge.svg?branch=master)](${repository(next)}/actions/workflows/ci.yml)`,
      ],
    ]);
  }
  await edit('VISION.md', [
    [`# ${previous.displayName} Vision\n`, `# ${next.displayName} Vision\n`],
    [
      `${previous.displayName} is an educational TypeScript starter`,
      `${next.displayName} is an educational TypeScript starter`,
    ],
  ]);
  for (const path of ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md']) {
    await edit(path, [
      [
        `Maintainer: [${previous.author}](${previous.contact}).`,
        `Maintainer: [${next.author}](${next.contact}).`,
      ],
    ]);
  }
  await edit('.github/CODEOWNERS', [
    [`\n* @${previous.owner}\n`, `\n* @${next.owner}\n`],
  ]);
  await edit('.github/ISSUE_TEMPLATE/config.yml', [
    [
      `url: ${repository(previous)}/security/policy`,
      `url: ${repository(next)}/security/policy`,
    ],
  ]);
  await edit('SECURITY.md', [
    [
      `[private security advisory](${repository(previous)}/security/advisories/new)`,
      `[private security advisory](${repository(next)}/security/advisories/new)`,
    ],
  ]);
  await edit('AGENTS.md', [
    [
      `Issues and specs are tracked in GitHub Issues for \`${previous.repository}\``,
      `Issues and specs are tracked in GitHub Issues for \`${next.repository}\``,
    ],
  ]);
  await edit('docs/agents/issue-tracker.md', [
    [
      `[GitHub Issues](${repository(previous)}/issues)`,
      `[GitHub Issues](${repository(next)}/issues)`,
    ],
  ]);
  return changes;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean' },
      apply: { type: 'boolean' },
      'display-name': { type: 'string' },
      'package-name': { type: 'string' },
      author: { type: 'string' },
      owner: { type: 'string' },
      repository: { type: 'string' },
      contact: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  const next = validateIdentity({
    displayName: values['display-name'],
    packageName: values['package-name'],
    author: values.author,
    owner: values.owner,
    repository: values.repository,
    contact: values.contact,
  });
  const root = await realpath(process.cwd());
  const changes = await planRename(root, next);
  if (values.apply) {
    for (const change of changes) {
      if ((await readFile(join(root, change.path), 'utf8')) !== change.original)
        throw new Error(
          `Identity surface changed while planning: ${change.path}. No files written.`,
        );
    }
    for (const change of changes)
      await writeFile(join(root, change.path), change.updated);
  }
  console.log(
    JSON.stringify(
      {
        mode: values.apply ? 'applied' : 'preview',
        changes: changes.map(({ path, edits }) => ({ path, edits })),
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

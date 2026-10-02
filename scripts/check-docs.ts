import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import GithubSlugger from 'github-slugger';
import { decodeHTML, decodeHTMLAttribute } from 'entities';
import { z } from 'zod';
import { runCommand } from './lib/command';
import { documentFiles } from './lib/document-files';
import { tableNames } from './lib/document-tables';

interface MarkdownDocument {
  anchors: Set<string>;
  links: string[];
}

async function parseMarkdown(source: string): Promise<MarkdownDocument> {
  const document: MarkdownDocument = { anchors: new Set(), links: [] };
  const slugger = new GithubSlugger();
  const headings = 'h1, h2, h3, h4, h5, h6';
  let heading: string | undefined;
  const rewriter = new HTMLRewriter()
    .on(headings, {
      element(element) {
        heading = '';
        element.onEndTag(() => {
          document.anchors.add(slugger.slug(decodeHTML(heading ?? '')));
          heading = undefined;
        });
      },
      text(text) {
        if (heading !== undefined) heading += text.text;
      },
    })
    .on('[id]', {
      element(element) {
        document.anchors.add(
          decodeHTMLAttribute(element.getAttribute('id') ?? ''),
        );
      },
    })
    .on('a[name]', {
      element(element) {
        document.anchors.add(
          decodeHTMLAttribute(element.getAttribute('name') ?? ''),
        );
      },
    })
    .on('a[href]', {
      element(element) {
        document.links.push(
          decodeHTMLAttribute(element.getAttribute('href') ?? ''),
        );
      },
    })
    .on('img[src]', {
      element(element) {
        document.links.push(
          decodeHTMLAttribute(element.getAttribute('src') ?? ''),
        );
        if (heading !== undefined) heading += element.getAttribute('alt') ?? '';
      },
    });
  await rewriter.transform(new Response(Bun.markdown.html(source))).text();
  return document;
}

async function checkCommandDocumentation(
  files: Awaited<ReturnType<typeof documentFiles>>,
): Promise<string[]> {
  if ((await files.kind('package.json')) !== 'file') return [];
  const { scripts } = z
    .object({ scripts: z.record(z.string(), z.string()).default({}) })
    .parse(JSON.parse(await files.read('package.json')));
  const commands = Object.entries(scripts)
    .filter(([, command]) => /\bnx run(-many)?\b/.test(command))
    .map(([name]) => name);
  if (!commands.length) return [];
  const guide = 'docs/nx-workspace.md';
  if ((await files.kind(guide)) !== 'file')
    return [`${guide}: missing command documentation`];
  let names: string[];
  try {
    names = tableNames(await files.read(guide), 'Commands');
  } catch (error) {
    return [
      `${guide}: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  // A documented wildcard covers one colon-delimited script-name segment.
  const documented = names.map(
    (name) =>
      new RegExp(
        `^${name
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^:]+')}$`,
      ),
  );
  return commands
    .filter((name) => !documented.some((pattern) => pattern.test(name)))
    .map((name) => `${guide}: undocumented Nx command: ${name}`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--staged'))
    throw new Error('Usage: bun scripts/check-docs.ts [--staged]');
  const rootResult = await runCommand(['git', 'rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
  });
  if (rootResult.code !== 0) throw new Error(rootResult.stderr);
  const root = rootResult.stdout.trim();
  const files = await documentFiles(root, args[0] === '--staged');
  const documents = new Map<string, MarkdownDocument>();
  for (const file of files.paths.filter(
    (file) => extname(file).toLowerCase() === '.md',
  )) {
    const path = join(root, file);
    if ((await files.kind(file)) !== 'file') continue;
    documents.set(path, await parseMarkdown(await files.read(file)));
  }
  const failures = await checkCommandDocumentation(files);
  for (const [source, document] of documents) {
    for (const link of document.links) {
      if (!link || /^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith('//'))
        continue;
      try {
        const hash = link.indexOf('#');
        const path = decodeURIComponent(
          (hash === -1 ? link : link.slice(0, hash)).split('?')[0],
        );
        const fragment =
          hash === -1 ? '' : decodeURIComponent(link.slice(hash + 1));
        const target = path
          ? resolve(
              path.startsWith('/') ? root : dirname(source),
              path.replace(/^\//, ''),
            )
          : source;
        const within = relative(root, target);
        if (within === '..' || within.startsWith('../') || isAbsolute(within))
          throw new Error('target is outside the repository');
        const kind = await files.kind(within);
        if (!kind) throw new Error('target does not exist');
        const markdown =
          kind === 'directory' ? join(target, 'README.md') : target;
        if (fragment && extname(markdown).toLowerCase() === '.md') {
          let destination = documents.get(markdown);
          if (!destination) {
            destination = await parseMarkdown(
              await files.read(relative(root, markdown)),
            );
            documents.set(markdown, destination);
          }
          if (!destination.anchors.has(fragment))
            throw new Error(`anchor #${fragment} does not exist`);
        }
      } catch (error) {
        failures.push(
          `${relative(root, source)}: ${link}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  for (const failure of failures) console.error(failure);
  console.log(
    `docs: ${String(documents.size)} Markdown files checked; ${String(failures.length)} documentation errors.`,
  );
  return failures.length ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(String(error));
  process.exitCode = 2;
}

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = realpathSync(resolve(import.meta.dir, '..'));

function location(
  fileName: string,
  span: ts.TextSpan,
): { file: string; line: number; column: number } {
  const source = ts.createSourceFile(
    fileName,
    ts.sys.readFile(fileName) ?? '',
    ts.ScriptTarget.Latest,
  );
  const position = source.getLineAndCharacterOfPosition(span.start);
  return {
    file: relative(root, fileName),
    line: position.line + 1,
    column: position.character + 1,
  };
}

function main(): void {
  const [operation, file, lineText, columnText, ...extra] =
    process.argv.slice(2);
  const line = Number(lineText);
  const column = Number(columnText);
  if (
    !['definition', 'references'].includes(operation) ||
    !file ||
    extra.length ||
    !Number.isSafeInteger(line) ||
    line < 1 ||
    !Number.isSafeInteger(column) ||
    column < 1
  ) {
    throw new Error(
      'Usage: bun scripts/typescript-query.ts <definition|references> <file> <line> <column> (1-based)',
    );
  }
  const path = realpathSync(resolve(process.cwd(), file));
  const local = relative(root, path);
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
    throw new Error('File must belong to this workspace');
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), (name) =>
    ts.sys.readFile(name),
  );
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (name) => name,
        getNewLine: () => '\n',
      }),
    );
  const host: ts.LanguageServiceHost = {
    ...ts.sys,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: () => '0',
    getScriptSnapshot: (name) => {
      const content = ts.sys.readFile(name);
      return content === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
  };
  const service = ts.createLanguageService(host);
  try {
    const source = service.getProgram()?.getSourceFile(path);
    if (!source) throw new Error('File is outside the root TypeScript project');
    const lines = source.getLineStarts();
    const start = lines.at(line - 1);
    const end = lines[line] ?? source.text.length;
    if (start === undefined || start + column - 1 >= end)
      throw new Error('Position is outside the requested line');
    const position = start + column - 1;
    const results =
      operation === 'definition'
        ? service.getDefinitionAtPosition(path, position)
        : service.getReferencesAtPosition(path, position);
    console.log(
      JSON.stringify(
        (results ?? []).map((result) =>
          location(result.fileName, result.textSpan),
        ),
        null,
        2,
      ),
    );
  } finally {
    service.dispose();
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

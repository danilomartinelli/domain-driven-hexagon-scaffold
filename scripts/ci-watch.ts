import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runCommand } from './lib/command';

const sha = z.string().regex(/^[a-f\d]{40}$/i);
const prSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  headRefOid: sha,
  headRefName: z.string(),
  baseRefName: z.string(),
  body: z.string(),
  closingIssuesReferences: z.array(z.object({ number: z.number() }).loose()),
});
const runSchema = z.object({
  databaseId: z.number().int().positive(),
  url: z.string(),
  headSha: sha,
  status: z.string(),
  conclusion: z.string().nullable(),
  attempt: z.number().optional(),
});
const detailSchema = runSchema.extend({
  jobs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      steps: z.array(
        z.object({
          name: z.string(),
          status: z.string(),
          conclusion: z.string().nullable(),
        }),
      ),
    }),
  ),
});
type Outcome = 'passed' | 'failed' | 'unavailable' | 'blocked' | 'timed_out';
const exitCodes: Record<Outcome, number> = {
  passed: 0,
  failed: 1,
  unavailable: 2,
  blocked: 3,
  timed_out: 4,
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pr: { type: 'string' },
      repo: { type: 'string' },
      output: { type: 'string' },
      'interval-ms': { type: 'string', default: '15000' },
      'timeout-ms': { type: 'string', default: '1800000' },
    },
  });
  const prNumber = z.coerce.number().int().positive().parse(values.pr);
  const interval = z.coerce
    .number()
    .int()
    .positive()
    .parse(values['interval-ms']);
  const timeout = z.coerce
    .number()
    .int()
    .positive()
    .parse(values['timeout-ms']);
  const deadline = Date.now() + timeout;
  const output = resolve(
    values.output ?? `.context/ci/pr-${String(prNumber)}.json`,
  );
  let repository = values.repo;
  let pullRequest: z.infer<typeof prSchema> | undefined;
  let run: z.infer<typeof detailSchema> | undefined;
  let head: string | undefined;
  let lastProgress = '';
  const heads: string[] = [];

  async function gh<T>(schema: z.ZodType<T>, args: string[]): Promise<T> {
    if (Date.now() >= deadline)
      throw new Error('CI observation deadline reached.');
    const result = await runCommand(['gh', ...args], {
      cwd: process.cwd(),
      timeout: Math.min(15_000, deadline - Date.now()),
    });
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || 'GitHub query failed.');
    return schema.parse(JSON.parse(result.stdout));
  }

  function finish(status: Outcome, reason: string): number {
    const evidence = {
      observedAt: new Date().toISOString(),
      status,
      reason,
      exitCode: exitCodes[status],
      repository,
      workflow: 'CI',
      headSha: head,
      observedHeads: heads,
      pullRequest,
      run,
    };
    mkdirSync(dirname(output), { recursive: true });
    const temporary = `${output}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`);
    renameSync(temporary, output);
    console.log(`[ci:${status}] ${reason} Evidence: ${output}`);
    return exitCodes[status];
  }

  function report(value: string): void {
    if (value === lastProgress) return;
    console.log(`[ci:progress] ${value}`);
    lastProgress = value;
  }

  try {
    repository ??= (
      await gh(z.object({ nameWithOwner: z.string() }), [
        'repo',
        'view',
        '--json',
        'nameWithOwner',
      ])
    ).nameWithOwner;
    const repo = z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .parse(repository);
    const readPr = () =>
      gh(prSchema, [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        repo,
        '--json',
        'number,url,headRefOid,headRefName,baseRefName,body,closingIssuesReferences',
      ]);
    const readRuns = (pr: z.infer<typeof prSchema>) =>
      gh(z.array(runSchema), [
        'run',
        'list',
        '--repo',
        repo,
        '--commit',
        pr.headRefOid,
        '--branch',
        pr.headRefName,
        '--workflow',
        'CI',
        '--limit',
        '10',
        '--json',
        'databaseId,url,headSha,status,conclusion,attempt',
      ]);
    const latest = (
      runs: z.infer<typeof runSchema>[],
    ): z.infer<typeof runSchema> | undefined =>
      runs.sort((a, b) => b.databaseId - a.databaseId)[0];
    while (Date.now() < deadline) {
      pullRequest = await readPr();
      if (pullRequest.headRefOid !== head) {
        head = pullRequest.headRefOid;
        heads.push(head);
        run = undefined;
        lastProgress = '';
        console.log(`[ci:head] ${head}`);
      }
      const candidate = latest(await readRuns(pullRequest));
      if (!candidate)
        report(`${head.slice(0, 7)}: waiting for CI registration`);
      else {
        run = await gh(detailSchema, [
          'run',
          'view',
          String(candidate.databaseId),
          '--repo',
          repository,
          '--json',
          'databaseId,url,headSha,status,conclusion,attempt,jobs',
        ]);
        if (candidate.headSha !== head || run.headSha !== head)
          throw new Error(
            'CI run does not match the observed pull request head.',
          );
        if (run.status === 'completed') {
          const verified = await readPr();
          if (verified.headRefOid !== head) continue;
          pullRequest = verified;
          const current = latest(await readRuns(verified));
          if (
            current?.databaseId !== run.databaseId ||
            current.attempt !== run.attempt ||
            current.status !== 'completed'
          )
            continue;
          const executed = run.jobs.some((job) =>
            job.steps.some((step) => step.status === 'completed'),
          );
          if (run.conclusion === 'action_required' || !executed)
            return finish(
              'blocked',
              `CI could not execute (${run.conclusion ?? 'no conclusion'}). Inspect ${run.url} for required actions.`,
            );
          if (run.conclusion === 'success')
            return finish('passed', `CI passed for ${head}. ${run.url}`);
          return finish(
            'failed',
            `CI concluded ${run.conclusion ?? 'without a result'} for ${head}. Inspect ${run.url}.`,
          );
        }
        const active = run.jobs
          .filter((job) => job.status !== 'completed')
          .map((job) => {
            const step = job.steps.find(
              (item) => item.status === 'in_progress',
            );
            return step
              ? `${job.name} / ${step.name}`
              : `${job.name}: ${job.status}`;
          });
        report(
          `${head.slice(0, 7)} run ${String(run.databaseId)}: ${active.join(', ') || run.status}`,
        );
      }
      await Bun.sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
    }
    return finish(
      'timed_out',
      'CI is still pending at the observation deadline; no approval recorded.',
    );
  } catch (error) {
    return finish(
      Date.now() >= deadline ? 'timed_out' : 'unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(
    `[ci:error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 2;
}

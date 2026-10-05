import { buildImage } from './lib/image';

try {
  const [app, ...args] = process.argv.slice(2);
  if (!app || args.some((arg) => !/^--(platform|tag)=.+/.test(arg)))
    throw new Error(
      'Usage: bun run image:build <application> [--platform=linux/amd64|linux/arm64] [--tag=<image>]',
    );
  console.log(
    await buildImage(app, {
      platform: args.find((arg) => arg.startsWith('--platform='))?.slice(11),
      tag: args.find((arg) => arg.startsWith('--tag='))?.slice(6),
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

import {
  installationInfrastructure,
  requiredServices,
  type OwnedDatabase,
} from '../../database/owned-infrastructure';
import type { Artifact, InstallationState } from './operations-config';
import { provisionDatabase } from './operations-compose';
export type OperationsCommand = (
  args: string[],
  timeout?: number,
  cleanup?: boolean,
) => Promise<string>;
export type OneShot = (service: string, command: string[]) => Promise<string>;
/** Create absent identities and verify every supplied password against retained ones. */
export const provisionApplication = (
  compose: OperationsCommand,
  database: OwnedDatabase,
): Promise<string> =>
  compose([
    'exec',
    '-T',
    database.service,
    'sh',
    '-ec',
    provisionDatabase(database),
  ]);
/** Authenticate with the server's own broker configuration; the password never reaches a command line. */
export const verifyBrokerAccess = (
  oneShot: OneShot,
  messenger: Artifact,
): Promise<string> =>
  oneShot(`app-${messenger.declaration.name}`, [
    '-e',
    "import {connect} from 'amqplib'; import {configurationValue} from '@starter/nest-support/configuration'; try { const c=await connect({hostname:process.env.RABBITMQ_HOST,port:5672,username:process.env.RABBITMQ_USERNAME,password:configurationValue('RABBITMQ_PASSWORD'),vhost:process.env.RABBITMQ_VHOST},{timeout:2000});await c.close(); } catch { process.exit(1); }",
  ]);
export const refreshOperationsGateway = async (
  current: InstallationState,
  compose: OperationsCommand,
): Promise<void> => {
  if (
    [
      ...requiredServices(installationInfrastructure(current)).values(),
    ].includes('gateway')
  )
    await compose([
      'up',
      '-d',
      '--no-deps',
      '--force-recreate',
      '--wait',
      '--wait-timeout',
      '60',
      'gateway',
    ]);
};

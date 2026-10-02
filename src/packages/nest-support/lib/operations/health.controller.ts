import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ServiceHealth,
  type HealthSnapshot,
  type Readiness,
  type BacklogSnapshot,
} from './service-health';

@Controller('health')
export class HealthController {
  constructor(@Inject(ServiceHealth) private readonly health: ServiceHealth) {}

  @Get('live')
  live(): { service: string; status: 'alive' } {
    return { service: this.health.service, status: 'alive' };
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<HealthSnapshot> {
    const snapshot = await this.health.snapshot();
    response.status(
      [snapshot.http, snapshot.consumer, snapshot.publisher].some(
        ({ status }) => status === 'not_ready',
      )
        ? 503
        : 200,
    );
    return snapshot;
  }

  @Get('backlog')
  async backlog(
    @Res({ passthrough: true }) response: Response,
  ): Promise<BacklogSnapshot> {
    const snapshot = await this.health.backlog();
    response.status(snapshot.status === 'unavailable' ? 503 : 200);
    return snapshot;
  }

  @Get('ready/:component')
  async component(
    @Param('component') component: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Readiness & { service: string }> {
    if (
      component !== 'http' &&
      component !== 'consumer' &&
      component !== 'publisher'
    ) {
      throw new NotFoundException();
    }
    const snapshot = await this.health.snapshot();
    const state = snapshot[component];
    response.status(state.status === 'not_ready' ? 503 : 200);
    return { service: snapshot.service, ...state };
  }
}

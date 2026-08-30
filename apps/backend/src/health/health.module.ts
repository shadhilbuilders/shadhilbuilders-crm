// Health check module — used by Coolify / Better Stack uptime monitoring.
import { Controller, Get, Module } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

@Controller('health')
class HealthController {
  @Public()
  @Get()
  check(): { status: 'ok'; uptimeSec: number; timestamp: string } {
    return {
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}

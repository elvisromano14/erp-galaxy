import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/decorators';
import { PrismaService } from '../../common/db/prisma.service';
import { RedisService } from '../../common/db/redis.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  @Public() @Get()
  live() { return { status: 'ok' }; }

  @Public() @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      await this.redis.client.ping();
      return { status: 'ready' };
    } catch (e) {
      throw new ServiceUnavailableException({ error: 'NOT_READY', message: (e as Error).message });
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}

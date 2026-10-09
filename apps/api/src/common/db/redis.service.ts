import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../../config/env';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  async onModuleDestroy() { await this.client.quit().catch(() => undefined); }
}

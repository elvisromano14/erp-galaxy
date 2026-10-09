import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { Job, Processor, Queue, Worker, WorkerOptions } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../../config/env';

/**
 * Conexión y colas de BullMQ (erp-v3 §20). Los trabajos se encolan desde cualquier proceso; solo procesan
 * los que tienen `WORKER_ENABLED=true` (la API misma o un proceso aparte: `pnpm worker`).
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly log = new Logger('Queue');
  // BullMQ exige `maxRetriesPerRequest: null` en las conexiones de los workers.
  private conn?: Redis;
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];

  private connection() { return (this.conn ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })); }

  queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) { q = new Queue(name, { connection: this.connection(), prefix: env.QUEUE_PREFIX }); this.queues.set(name, q); }
    return q;
  }

  /** Registra un worker para la cola (no hace nada si este proceso no procesa colas). */
  worker<T = unknown>(name: string, processor: Processor<T>, opts: Partial<WorkerOptions> = {}): Worker<T> | null {
    if (!env.WORKER_ENABLED) return null;
    const w = new Worker<T>(name, processor, { connection: this.connection(), prefix: env.QUEUE_PREFIX, concurrency: 1, ...opts });
    w.on('failed', (job: Job<T> | undefined, err: Error) => this.log.warn(`${name}#${job?.id} falló: ${err.message}`));
    w.on('error', (err: Error) => this.log.warn(`${name}: ${err.message}`));
    this.workers.push(w);
    return w;
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map(w => w.close().catch(() => undefined)));
    await Promise.all([...this.queues.values()].map(q => q.close().catch(() => undefined)));
    await this.conn?.quit().catch(() => undefined);
  }
}

@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}

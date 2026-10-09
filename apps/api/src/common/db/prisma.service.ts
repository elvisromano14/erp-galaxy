import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { als, Db, getStore, RequestStore, Tx } from './tenant-context';
import { BusinessRuleException } from '../errors/errors';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  // PrismaClient devuelve un Proxy desde su constructor; los getters de la subclase reciben el objeto
  // original, sin los modelos. Guardamos el proxy para devolverlo desde `db`.
  private readonly proxy: PrismaClient;
  constructor() {
    super();
    this.proxy = this;
  }

  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }

  /** Cliente a usar: la transacción de la petición (con RLS fijado) o el cliente global (tablas sin RLS). */
  get db(): Db { return getStore().tx ?? this.proxy; }

  /** Transacción de la petición; falla si no hay contexto de empresa. */
  get tx(): Tx {
    const tx = getStore().tx;
    if (!tx) throw new BusinessRuleException('No hay contexto de empresa activo', 'NO_TENANT_CONTEXT');
    return tx;
  }

  get companyId(): string {
    const id = getStore().companyId;
    if (!id) throw new BusinessRuleException('No hay empresa seleccionada', 'NO_COMPANY_SELECTED');
    return id;
  }
  get userId(): string | undefined { return getStore().userId; }

  /**
   * Ejecuta `fn` dentro de una transacción con `app.company_id` fijado (RLS).
   * Si ya hay una transacción de petición para la misma empresa, la reutiliza.
   */
  async runWithTenant<T>(companyId: string, fn: (tx: Tx) => Promise<T>, extra: Partial<RequestStore> = {}, timeoutMs = 60_000): Promise<T> {
    const current = getStore();
    if (current.tx && current.companyId === companyId) return fn(current.tx);
    return this.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
        return als.run({ ...current, ...extra, tx, companyId }, () => fn(tx));
      },
      { timeout: timeoutMs, maxWait: 10_000 },
    );
  }
}

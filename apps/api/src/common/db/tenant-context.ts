import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

export interface RequestStore {
  tx?: Tx;
  companyId?: string;
  userId?: string;
  requestId?: string;
  ip?: string;
  /** La petición viene de una cuenta de servicio (integrador): sus escrituras no se reenvían como eventos. */
  isService?: boolean;
  /** Origen de las escrituras de esta petición para los eventos de integración (por defecto ERP). */
  origin?: 'ERP' | 'MOBILE' | 'INTEGRATION';
}

export const als = new AsyncLocalStorage<RequestStore>();
export const getStore = (): RequestStore => als.getStore() ?? {};
export type Db = Tx | PrismaClient;

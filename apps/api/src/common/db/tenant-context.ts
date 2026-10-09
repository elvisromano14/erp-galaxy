import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

export interface RequestStore {
  tx?: Tx;
  companyId?: string;
  userId?: string;
  requestId?: string;
  ip?: string;
}

export const als = new AsyncLocalStorage<RequestStore>();
export const getStore = (): RequestStore => als.getStore() ?? {};
export type Db = Tx | PrismaClient;

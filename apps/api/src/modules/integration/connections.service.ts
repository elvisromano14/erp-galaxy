import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import { decryptSecret, encryptSecret } from '../../common/crypto/secret-box';
import { PrismaService } from '../../common/db/prisma.service';
import { BusinessRuleException, ConflictError, NotFoundError } from '../../common/errors/errors';
import { env } from '../../config/env';
import { conflictStatusSchema, createConnectionSchema, reportSchema, testResultSchema, updateConnectionSchema } from './integration.types';

type Conn = Prisma.IntegrationConnectionGetPayload<object>;
const ONLINE_FLOOR_MS = 90_000;
const RUN_RETENTION_DAYS = 30;
/** Campos cuyo cambio invalida la última prueba de conexión. */
const TEST_AFFECTING = ['host', 'port', 'databaseName', 'username', 'password', 'encrypt', 'trustServerCertificate'] as const;

/** Conexiones del integrador a las bases de Saint: se configuran aquí y el integrador las lee con su cuenta de servicio. */
@Injectable()
export class ConnectionsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  // ───────────────────────── administración (usuarios) ─────────────────────────
  async list() {
    const rows = await this.prisma.tx.integrationConnection.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows.map(r => this.view(r));
  }

  async get(id: string) { return this.view(await this.find(id)); }

  async create(input: z.infer<typeof createConnectionSchema>) {
    const companyId = this.prisma.companyId;
    const dup = await this.prisma.tx.integrationConnection.findFirst({ where: { connectorId: input.connectorId, deletedAt: null } });
    if (dup) throw new ConflictError(`Ya existe una conexión con el identificador «${input.connectorId}»`, 'CONNECTOR_EXISTS');
    const { password, ...rest } = input;
    const row = await this.prisma.tx.integrationConnection.create({ data: { ...rest, companyId, passwordEnc: encryptSecret(password, env.INTEGRATION_SECRET_KEY), createdBy: this.prisma.userId ?? null } });
    await this.audit.log('integration_connection', row.id, 'CREATE', { connectorId: row.connectorId, host: row.host, database: row.databaseName });
    return this.view(row);
  }

  async update(id: string, input: z.infer<typeof updateConnectionSchema>) {
    const cur = await this.find(id);
    const { password, version, ...rest } = input;
    if (version !== undefined && version !== cur.version) throw new ConflictError(`La conexión cambió (versión ${cur.version}); recargue antes de guardar`, 'VERSION_CONFLICT');
    const merged = { ...cur, ...rest };
    const issues: string[] = [];
    if (merged.mode === 'READ_ONLY' && merged.outbound.length) issues.push('Los flujos ERP → Saint exigen el modo READ_WRITE');
    if (merged.mode === 'READ_WRITE' && !merged.allowedWriteDatabases.includes(merged.databaseName)) issues.push('Incluya la base de datos en las bases permitidas para escribir');
    if (issues.length) throw new BusinessRuleException(issues[0], 'INVALID_CONNECTION', issues.map(message => ({ code: 'INVALID', message })));

    const data: Prisma.IntegrationConnectionUpdateInput = { ...rest, version: { increment: 1 } };
    if (password !== undefined) data.passwordEnc = encryptSecret(password, env.INTEGRATION_SECRET_KEY);
    const changedTarget = TEST_AFFECTING.some(k => (k === 'password' ? password !== undefined : (rest as any)[k] !== undefined && (rest as any)[k] !== (cur as any)[k]));
    if (changedTarget) Object.assign(data, { testOk: null, testAt: null, testMessage: null, testLatencyMs: null, testDatabases: [], testSchema: Prisma.DbNull, testRequestedAt: null });
    const row = await this.prisma.tx.integrationConnection.update({ where: { id }, data });
    // Nunca se registra la clave: solo qué campos cambiaron.
    await this.audit.log('integration_connection', id, 'UPDATE', { fields: [...Object.keys(rest), ...(password !== undefined ? ['password'] : [])] });
    return this.view(row);
  }

  async remove(id: string) {
    const cur = await this.find(id);
    await this.prisma.tx.integrationConnection.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } });
    await this.audit.log('integration_connection', id, 'DELETE', { connectorId: cur.connectorId });
    return { ok: true };
  }

  /** El ERP no se conecta a Saint: deja la solicitud y el integrador (que sí tiene la red) la ejecuta y responde. */
  async requestTest(id: string) {
    await this.find(id);
    const row = await this.prisma.tx.integrationConnection.update({ where: { id }, data: { testRequestedAt: new Date() } });
    await this.audit.log('integration_connection', id, 'TEST_REQUEST', {});
    return this.view(row);
  }

  // ───────────────────────── monitoreo (usuarios) ─────────────────────────
  async monitor() {
    const tx = this.prisma.tx;
    const conns = await tx.integrationConnection.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } });
    const lastRuns = await tx.$queryRaw<Array<{ connector_id: string; stream: string; started_at: Date; finished_at: Date | null; rows_read: number; rows_applied: number; rows_failed: number; error: string | null }>>`
      SELECT DISTINCT ON (connector_id, stream) connector_id, stream, started_at, finished_at, rows_read, rows_applied, rows_failed, error
      FROM integration_runs WHERE started_at > now() - interval '7 days' ORDER BY connector_id, stream, started_at DESC`;
    const open = await tx.integrationConflict.groupBy({ by: ['connectorId'], where: { status: 'OPEN' }, _count: { _all: true } });
    return conns.map(c => {
      const runs = lastRuns.filter(r => r.connector_id === c.connectorId).map(r => ({
        stream: r.stream, startedAt: r.started_at, finishedAt: r.finished_at, rowsRead: r.rows_read, rowsApplied: r.rows_applied, rowsFailed: r.rows_failed, error: r.error,
      }));
      return { ...this.view(c), streamsStatus: runs, openConflicts: open.find(o => o.connectorId === c.connectorId)?._count._all ?? 0 };
    });
  }

  async runs(q: { connectorId?: string; limit: number }) {
    const rows = await this.prisma.tx.integrationRun.findMany({ where: q.connectorId ? { connectorId: q.connectorId } : {}, orderBy: { startedAt: 'desc' }, take: q.limit });
    return rows.map(r => ({ ...r, id: Number(r.id) }));
  }

  async conflicts(q: { status?: string; connectorId?: string; limit: number }) {
    return this.prisma.tx.integrationConflict.findMany({
      where: { ...(q.status ? { status: q.status } : {}), ...(q.connectorId ? { connectorId: q.connectorId } : {}) },
      orderBy: { updatedAt: 'desc' }, take: q.limit,
    });
  }

  async setConflictStatus(id: string, b: z.infer<typeof conflictStatusSchema>) {
    const c = await this.prisma.tx.integrationConflict.findUnique({ where: { id } });
    if (!c) throw new NotFoundError('Conflicto', id);
    if (c.status === 'RESOLVED') throw new BusinessRuleException('El conflicto ya está resuelto', 'CONFLICT_RESOLVED');
    const row = await this.prisma.tx.integrationConflict.update({ where: { id }, data: { status: b.status, note: b.note ?? c.note, updatedAt: new Date() } });
    await this.audit.log('integration_conflict', id, b.status === 'ACKNOWLEDGED' ? 'ACKNOWLEDGE' : 'REOPEN', { note: b.note });
    return row;
  }

  // ───────────────────────── API del integrador (cuenta de servicio) ─────────────────────────
  /** Conexiones activas con la clave descifrada. Solo la cuenta de servicio de la empresa llega aquí. */
  async runtime() {
    const rows = await this.prisma.tx.integrationConnection.findMany({ where: { deletedAt: null, enabled: true }, orderBy: { createdAt: 'asc' } });
    if (rows.length) await this.prisma.tx.integrationConnection.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { lastSeenAt: new Date() } });
    return rows.map(r => ({
      id: r.id, connectorId: r.connectorId, name: r.name, version: r.version,
      saint: { host: r.host, port: r.port, database: r.databaseName, user: r.username, password: decryptSecret(r.passwordEnc, env.INTEGRATION_SECRET_KEY), encrypt: r.encrypt, trustServerCertificate: r.trustServerCertificate },
      mode: r.mode, allowedWriteDatabases: r.allowedWriteDatabases, pollIntervalSec: r.pollIntervalSec, streams: r.streams, outbound: r.outbound, priceCurrency: r.priceCurrency,
      testRequestedAt: r.testRequestedAt, testAt: r.testAt,
    }));
  }

  async saveTestResult(id: string, b: z.infer<typeof testResultSchema>) {
    await this.find(id);
    await this.prisma.tx.integrationConnection.update({
      where: { id },
      data: { testAt: new Date(), testOk: b.ok, testMessage: b.message, testLatencyMs: b.latencyMs ?? null, testDatabases: b.databases, testSchema: (b.schema ?? Prisma.DbNull) as Prisma.InputJsonValue },
    });
    return { ok: true };
  }

  async report(b: z.infer<typeof reportSchema>) {
    const tx = this.prisma.tx; const companyId = this.prisma.companyId;
    const conn = await tx.integrationConnection.findFirst({ where: { connectorId: b.connectorId, deletedAt: null } });
    if (!conn) throw new NotFoundError('Conexión', b.connectorId);
    await tx.integrationConnection.update({ where: { id: conn.id }, data: { lastSeenAt: new Date() } });
    if (b.runs.length) {
      await tx.integrationRun.createMany({ data: b.runs.map(r => ({ companyId, connectorId: b.connectorId, stream: r.stream, startedAt: new Date(r.startedAt), finishedAt: r.finishedAt ? new Date(r.finishedAt) : null, rowsRead: r.rowsRead, rowsApplied: r.rowsApplied, rowsFailed: r.rowsFailed, error: r.error ?? null })) });
      await tx.integrationRun.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - RUN_RETENTION_DAYS * 86_400_000) } } });
    }
    for (const c of b.conflicts) {
      const where = { companyId_connectorId_entity_saintKey_kind: { companyId, connectorId: b.connectorId, entity: c.entity, saintKey: c.saintKey, kind: c.kind } };
      const cur = await tx.integrationConflict.findUnique({ where });
      if (c.op === 'OPEN') {
        const detail = (c.detail ?? Prisma.DbNull) as Prisma.InputJsonValue;
        if (!cur) await tx.integrationConflict.create({ data: { companyId, connectorId: b.connectorId, entity: c.entity, saintKey: c.saintKey, erpId: c.erpId ?? null, kind: c.kind, detail } });
        else await tx.integrationConflict.update({ where, data: { detail, erpId: c.erpId ?? cur.erpId, updatedAt: new Date(), ...(cur.status === 'RESOLVED' ? { status: 'OPEN', resolvedAt: null } : {}) } });
      } else if (cur && cur.status !== 'RESOLVED') {
        await tx.integrationConflict.update({ where, data: { status: 'RESOLVED', resolvedAt: new Date(), updatedAt: new Date() } });
      }
    }
    return { ok: true };
  }

  // ───────────────────────── utilidades ─────────────────────────
  private async find(id: string): Promise<Conn> {
    const row = await this.prisma.tx.integrationConnection.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new NotFoundError('Conexión', id);
    return row;
  }

  /** Vista para usuarios: la clave nunca sale (solo si existe). */
  private view(c: Conn) {
    const { passwordEnc, ...rest } = c;
    const windowMs = Math.max(ONLINE_FLOOR_MS, c.pollIntervalSec * 3000);
    return { ...rest, hasPassword: !!passwordEnc, online: !!c.lastSeenAt && Date.now() - c.lastSeenAt.getTime() < windowMs, testPending: !!c.testRequestedAt && (!c.testAt || c.testRequestedAt > c.testAt) };
  }
}

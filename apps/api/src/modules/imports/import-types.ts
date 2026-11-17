import { Prisma } from '@prisma/client';
import { formatRif, isValidRif } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { InventoryDocsService } from '../inventory/inventory-docs.service';
import { ProductsService } from '../products/products.service';
import { IntegrationEventsService } from '../integration/integration-events.service';
import { parseBool, parseDecimal, splitList } from './import-file';

type Tx = Prisma.TransactionClient;

export interface ImportColumn { key: string; header: string; required?: boolean; help: string; example: string }
export interface ImportOptions { onExisting: 'skip' | 'update' }
export interface ImportCtx { prisma: PrismaService; tx: Tx; companyId: string; userId?: string; docs: InventoryDocsService; products: ProductsService; events: IntegrationEventsService; today: string }
export interface Planned<T = Record<string, any>> { row: number; action: 'create' | 'update' | 'skip'; errors: string[]; warnings: string[]; data: T; label: string }
export type RawRow = { row: number; values: Record<string, string> };

export interface ImportTypeDef {
  key: string; title: string; description: string;
  /** Además de `admin:import:create`, el usuario necesita este permiso del módulo destino. */
  permission: string;
  columns: ImportColumn[];
  supportsExisting: boolean;
  /** Libro con una hoja por depósito: se leen todas las hojas (ver `parseImportFile`). */
  allSheets?: boolean;
  plan(ctx: ImportCtx, rows: RawRow[], o: ImportOptions): Promise<Planned[]>;
  apply(ctx: ImportCtx, planned: Planned[]): Promise<{ created: number; updated: number; note?: string }>;
}

const c = (key: string, header: string, help: string, example: string, required = false): ImportColumn => ({ key, header, required, help, example });
const v = (r: RawRow, k: string) => r.values[k] ?? '';
const SI_NO = 'SI / NO';

/** Resuelve la acción según exista el registro y la opción elegida. */
function actionFor(exists: boolean, o: ImportOptions, p: Planned) {
  if (!exists) { p.action = 'create'; return; }
  if (o.onExisting === 'update') { p.action = 'update'; p.warnings.push('Ya existe: se actualizará'); } else { p.action = 'skip'; p.warnings.push('Ya existe: se omite'); }
}

const dup = <T>(seen: Map<string, number>, key: string, row: number, p: Planned, what: string) => {
  const first = seen.get(key);
  if (first !== undefined) p.errors.push(`${what} repetido en el archivo (también en la fila ${first})`);
  else seen.set(key, row);
};

// ═══════════════════════════ PRODUCTOS ═══════════════════════════
const products: ImportTypeDef = {
  key: 'products', title: 'Productos', description: 'Maestro de productos con códigos de barras, referencias OEM y precio de la lista predeterminada. Los vacíos al actualizar no modifican el dato.',
  permission: 'admin:products:create', supportsExisting: true,
  columns: [
    c('sku', 'sku', 'Código único del producto', 'PAS-001', true), c('nombre', 'nombre', 'Nombre del producto', 'Pastillas de freno delanteras', true),
    c('descripcion', 'descripcion', 'Descripción opcional', 'Juego x4'), c('instancia', 'instancia', 'Código de la instancia (categoría) existente', 'FRENOS'),
    c('unidad', 'unidad', 'Código de la unidad (por defecto UND)', 'UND'), c('impuesto', 'impuesto', 'Código del impuesto (p. ej. IVA_GENERAL, EXENTO)', 'IVA_GENERAL'),
    c('marca', 'marca', 'Marca (texto libre, opcional, máx. 80)', 'MHW'), c('ubicacion', 'ubicacion', 'Código de la ubicación existente (opcional)', 'P1-E6-P4'),
    c('es_servicio', 'es_servicio', SI_NO + ' (por defecto NO)', 'NO'), c('stock_minimo', 'stock_minimo', 'Mínimo para reposición', '5'), c('stock_maximo', 'stock_maximo', 'Máximo para reposición', '20'),
    c('codigos_barras', 'codigos_barras', 'Varios separados por coma, | o ;', '7591234567890;7591234567891'), c('codigos_oem', 'codigos_oem', 'Referencias OEM separadas por coma, | o ;', '04465-0K290'),
    c('precio', 'precio', 'Precio en la lista predeterminada (moneda de la lista)', '25,50'), c('activo', 'activo', SI_NO + ' (por defecto SI)', 'SI'),
  ],
  async plan(ctx, rows, o) {
    const { tx } = ctx;
    const [cats, units, taxes, existing, lists, locs] = await Promise.all([
      tx.category.findMany({ where: { deletedAt: null } }), tx.unit.findMany({ where: { deletedAt: null } }),
      tx.tax.findMany({ where: { deletedAt: null, isActive: true, validFrom: { lte: new Date(ctx.today) } }, orderBy: { validFrom: 'desc' } }),
      tx.product.findMany({ where: { deletedAt: null }, select: { id: true, sku: true } }), tx.priceList.findMany({ where: { deletedAt: null, isDefault: true } }),
      tx.location.findMany({ where: { deletedAt: null }, select: { id: true, code: true } }),
    ]);
    const locBy = new Map(locs.map(x => [x.code.toLowerCase(), x.id]));
    const catBy = new Map(cats.map(x => [x.code.toLowerCase(), x.id])); const unitBy = new Map(units.map(x => [x.code.toLowerCase(), x.id]));
    const taxBy = new Map<string, string>(); for (const t of taxes) if (!taxBy.has(t.code.toLowerCase())) taxBy.set(t.code.toLowerCase(), t.id);
    const skuBy = new Map(existing.map(x => [x.sku.toLowerCase(), x.id]));
    const barcodes = await tx.productBarcode.findMany({ select: { barcode: true, productId: true } });
    const barcodeOwner = new Map(barcodes.map(b => [b.barcode, b.productId]));
    const seenSku = new Map<string, number>(); const seenBarcode = new Map<string, number>();
    const defaultList = lists[0];

    return rows.map(r => {
      const p: Planned = { row: r.row, action: 'create', errors: [], warnings: [], data: {}, label: `${v(r, 'sku')} ${v(r, 'nombre')}`.trim() };
      const sku = v(r, 'sku'), name = v(r, 'nombre');
      if (!sku) p.errors.push('El SKU es obligatorio'); else if (sku.length > 60) p.errors.push('SKU demasiado largo (máx. 60)');
      if (sku) dup(seenSku, sku.toLowerCase(), r.row, p, 'SKU');
      const existingId = sku ? skuBy.get(sku.toLowerCase()) : undefined;
      if (!name && !existingId) p.errors.push('El nombre es obligatorio');
      const data: Record<string, any> = { sku, existingId };
      if (name) data.name = name;
      if (v(r, 'descripcion')) data.description = v(r, 'descripcion');
      if (v(r, 'instancia')) { const id = catBy.get(v(r, 'instancia').toLowerCase()); if (id) data.categoryId = id; else p.errors.push(`La instancia «${v(r, 'instancia')}» no existe (impórtela antes)`); }
      if (v(r, 'marca')) { if (v(r, 'marca').length > 80) p.errors.push('La marca no puede pasar de 80 caracteres'); else data.brand = v(r, 'marca'); }
      if (v(r, 'ubicacion')) { const id = locBy.get(v(r, 'ubicacion').toLowerCase()); if (id) data.locationId = id; else p.errors.push(`La ubicación «${v(r, 'ubicacion')}» no existe (impórtela antes)`); }
      const unitCode = v(r, 'unidad') || (existingId ? '' : 'UND');
      if (unitCode) { const id = unitBy.get(unitCode.toLowerCase()); if (id) data.unitId = id; else p.errors.push(`La unidad «${unitCode}» no existe`); }
      if (v(r, 'impuesto')) { const id = taxBy.get(v(r, 'impuesto').toLowerCase()); if (id) data.taxId = id; else p.errors.push(`El impuesto «${v(r, 'impuesto')}» no existe o no está vigente`); }
      const svc = parseBool(v(r, 'es_servicio'), false); if (svc === null) p.errors.push('es_servicio debe ser SI o NO'); else if (v(r, 'es_servicio')) data.isService = svc;
      const act = parseBool(v(r, 'activo'), true); if (act === null) p.errors.push('activo debe ser SI o NO'); else if (v(r, 'activo')) data.isActive = act;
      for (const [col, key] of [['stock_minimo', 'minStock'], ['stock_maximo', 'maxStock']] as const) {
        if (!v(r, col)) continue;
        const n = parseDecimal(v(r, col)); if (n === null || Number(n) < 0) p.errors.push(`${col} no es un número válido`); else data[key] = n;
      }
      if (data.minStock !== undefined && data.maxStock !== undefined && Number(data.maxStock) > 0 && Number(data.maxStock) < Number(data.minStock)) p.errors.push('stock_maximo no puede ser menor que stock_minimo');
      if (v(r, 'precio')) {
        const n = parseDecimal(v(r, 'precio')); if (n === null || Number(n) < 0) p.errors.push('precio no es un número válido');
        else if (!defaultList) p.errors.push('No hay lista de precios predeterminada'); else { data.price = n; data.priceListId = defaultList.id; }
      }
      data.barcodes = splitList(v(r, 'codigos_barras'));
      for (const b of data.barcodes as string[]) {
        dup(seenBarcode, b, r.row, p, `Código de barras ${b}`);
        const owner = barcodeOwner.get(b); if (owner && owner !== existingId) p.errors.push(`El código de barras ${b} ya pertenece a otro producto`);
      }
      data.oem = splitList(v(r, 'codigos_oem'));
      p.data = data;
      if (!p.errors.length) actionFor(!!existingId, o, p);
      return p;
    });
  },
  async apply(ctx, planned) {
    const { tx, companyId, userId } = ctx;
    const creates = planned.filter(p => p.action === 'create'); const updates = planned.filter(p => p.action === 'update');
    let created = 0;
    if (creates.length) {
      const rows = await tx.product.createManyAndReturn({
        data: creates.map(p => { const d = p.data; return {
          companyId, sku: d.sku, name: d.name, description: d.description ?? null, categoryId: d.categoryId ?? null, unitId: d.unitId, taxId: d.taxId ?? null, brand: d.brand ?? null, locationId: d.locationId ?? null,
          isService: d.isService ?? false, isActive: d.isActive ?? true, minStock: d.minStock ?? '0', maxStock: d.maxStock ?? '0', createdBy: userId, updatedBy: userId,
        }; }),
      });
      const idBySku = new Map(rows.map(x => [x.sku, x.id]));
      await tx.productBarcode.createMany({ data: creates.flatMap(p => (p.data.barcodes as string[]).map(barcode => ({ companyId, productId: idBySku.get(p.data.sku)!, barcode }))) });
      await tx.productReference.createMany({ data: creates.flatMap(p => (p.data.oem as string[]).map(code => ({ companyId, productId: idBySku.get(p.data.sku)!, refType: 'OEM', code }))) });
      await tx.productPrice.createMany({ data: creates.filter(p => p.data.price).map(p => ({ companyId, productId: idBySku.get(p.data.sku)!, priceListId: p.data.priceListId, price: p.data.price, validFrom: new Date(ctx.today), createdBy: userId })), skipDuplicates: true });
      created = rows.length;
    }
    for (const p of updates) {
      const d = p.data; const id = d.existingId as string;
      const { sku: _s, existingId: _e, barcodes, oem, price, priceListId, ...fields } = d;
      await tx.product.update({ where: { id }, data: { ...fields, updatedBy: userId, version: { increment: 1 } } });
      const haveB = new Set((await tx.productBarcode.findMany({ where: { productId: id } })).map(x => x.barcode));
      const newB = (barcodes as string[]).filter(b => !haveB.has(b));
      if (newB.length) await tx.productBarcode.createMany({ data: newB.map(barcode => ({ companyId, productId: id, barcode })) });
      const haveR = new Set((await tx.productReference.findMany({ where: { productId: id } })).map(x => x.code));
      const newR = (oem as string[]).filter(x => !haveR.has(x));
      if (newR.length) await tx.productReference.createMany({ data: newR.map(code => ({ companyId, productId: id, refType: 'OEM', code })) });
      if (price) await tx.productPrice.upsert({
        where: { companyId_productId_priceListId_validFrom: { companyId, productId: id, priceListId, validFrom: new Date(ctx.today) } },
        update: { price, createdBy: userId }, create: { companyId, productId: id, priceListId, price, validFrom: new Date(ctx.today), createdBy: userId },
      });
    }
    return { created, updated: updates.length };
  },
};

// ═══════════════════════════ TERCEROS (proveedores / clientes) ═══════════════════════════
function thirdParty(kind: 'suppliers' | 'customers'): ImportTypeDef {
  const isCustomer = kind === 'customers';
  const cols: ImportColumn[] = [
    c('rif', 'rif', 'RIF con dígito verificador (J-12345678-9)', 'J-12345678-4', true), c('razon_social', 'razon_social', 'Razón social', isCustomer ? 'Taller El Mecánico, C.A.' : 'Importadora Auto Partes, C.A.', true),
    c('nombre_comercial', 'nombre_comercial', 'Nombre comercial', ''), c('tipo_persona', 'tipo_persona', 'JURIDICA o NATURAL (por defecto JURIDICA)', 'JURIDICA'),
    c('contribuyente_especial', 'contribuyente_especial', SI_NO, 'NO'), c('retencion_iva', 'retencion_iva', 'Porcentaje de retención de IVA (0, 75, 100)', '0'),
    c('dias_credito', 'dias_credito', 'Días de crédito', '15'), c('zona', 'zona', 'Código de la zona existente', ''), c('correo', 'correo', 'Correo electrónico', ''), c('telefono', 'telefono', 'Teléfono', ''), c('direccion', 'direccion', 'Dirección', ''),
    ...(isCustomer ? [c('limite_credito', 'limite_credito', 'Límite de crédito', '1000'), c('lista_precios', 'lista_precios', 'Código de la lista de precios', 'DETAL'), c('vendedor', 'vendedor', 'Código del vendedor', '')] : [c('retencion_islr', 'retencion_islr', 'Sujeto a retención ISLR: ' + SI_NO, 'NO')]),
  ];
  return {
    key: kind, title: isCustomer ? 'Clientes' : 'Proveedores', description: `Maestro de ${isCustomer ? 'clientes' : 'proveedores'}. Se identifican por RIF; los vacíos al actualizar no modifican el dato.`,
    permission: isCustomer ? 'admin:customers:create' : 'admin:suppliers:create', supportsExisting: true, columns: cols,
    async plan(ctx, rows, o) {
      const { tx } = ctx;
      const [existing, zones, lists, sellers] = await Promise.all([
        isCustomer ? tx.customer.findMany({ where: { deletedAt: null }, select: { id: true, rif: true } }) : tx.supplier.findMany({ where: { deletedAt: null }, select: { id: true, rif: true } }),
        tx.zone.findMany({ where: { deletedAt: null } }), isCustomer ? tx.priceList.findMany({ where: { deletedAt: null } }) : Promise.resolve([]), isCustomer ? tx.seller.findMany({ where: { deletedAt: null } }) : Promise.resolve([]),
      ]);
      const rifBy = new Map(existing.map(x => [x.rif, x.id])); const zoneBy = new Map(zones.map(z => [z.code.toLowerCase(), z.id]));
      const listBy = new Map(lists.map(l => [l.code.toLowerCase(), l.id])); const sellerBy = new Map(sellers.map(s => [s.code.toLowerCase(), s.id]));
      const seen = new Map<string, number>();
      return rows.map(r => {
        const p: Planned = { row: r.row, action: 'create', errors: [], warnings: [], data: {}, label: `${v(r, 'rif')} ${v(r, 'razon_social')}`.trim() };
        const rawRif = v(r, 'rif'); let rif = '';
        if (!rawRif) p.errors.push('El RIF es obligatorio'); else if (!isValidRif(rawRif)) p.errors.push(`RIF inválido: ${rawRif}`); else { rif = formatRif(rawRif); dup(seen, rif, r.row, p, 'RIF'); }
        const existingId = rif ? rifBy.get(rif) : undefined;
        if (!v(r, 'razon_social') && !existingId) p.errors.push('La razón social es obligatoria');
        const d: Record<string, any> = { rif, existingId };
        if (v(r, 'razon_social')) d.legalName = v(r, 'razon_social');
        if (v(r, 'nombre_comercial')) d.tradeName = v(r, 'nombre_comercial');
        if (v(r, 'tipo_persona')) { const t = v(r, 'tipo_persona').toLowerCase(); if (['juridica', 'jurídica', 'legal'].includes(t)) d.personType = 'LEGAL'; else if (t === 'natural') d.personType = 'NATURAL'; else p.errors.push('tipo_persona debe ser JURIDICA o NATURAL'); }
        const ce = parseBool(v(r, 'contribuyente_especial'), false); if (ce === null) p.errors.push('contribuyente_especial debe ser SI o NO'); else if (v(r, 'contribuyente_especial')) d.isSpecialTaxpayer = ce;
        if (v(r, 'retencion_iva')) { const n = parseDecimal(v(r, 'retencion_iva')); if (n === null || Number(n) < 0 || Number(n) > 100) p.errors.push('retencion_iva debe estar entre 0 y 100'); else d.retentionIvaPct = n; }
        if (v(r, 'dias_credito')) { const n = Number(v(r, 'dias_credito')); if (!Number.isInteger(n) || n < 0 || n > 365) p.errors.push('dias_credito debe ser un entero entre 0 y 365'); else d.creditDays = n; }
        if (v(r, 'zona')) { const id = zoneBy.get(v(r, 'zona').toLowerCase()); if (id) d.zoneId = id; else p.errors.push(`La zona «${v(r, 'zona')}» no existe`); }
        if (v(r, 'correo')) { if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v(r, 'correo'))) d.email = v(r, 'correo'); else p.errors.push('correo inválido'); }
        if (v(r, 'telefono')) d.phone = v(r, 'telefono'); if (v(r, 'direccion')) d.address = v(r, 'direccion');
        if (isCustomer) {
          if (v(r, 'limite_credito')) { const n = parseDecimal(v(r, 'limite_credito')); if (n === null || Number(n) < 0) p.errors.push('limite_credito no es un número válido'); else d.creditLimit = n; }
          if (v(r, 'lista_precios')) { const id = listBy.get(v(r, 'lista_precios').toLowerCase()); if (id) d.priceListId = id; else p.errors.push(`La lista de precios «${v(r, 'lista_precios')}» no existe`); }
          if (v(r, 'vendedor')) { const id = sellerBy.get(v(r, 'vendedor').toLowerCase()); if (id) d.sellerId = id; else p.errors.push(`El vendedor «${v(r, 'vendedor')}» no existe`); }
        } else {
          const islr = parseBool(v(r, 'retencion_islr'), false); if (islr === null) p.errors.push('retencion_islr debe ser SI o NO'); else if (v(r, 'retencion_islr')) d.isIslrSubject = islr;
        }
        p.data = d;
        if (!p.errors.length) actionFor(!!existingId, o, p);
        return p;
      });
    },
    async apply(ctx, planned) {
      const { tx, companyId } = ctx;
      const model: any = isCustomer ? tx.customer : tx.supplier;
      const creates = planned.filter(p => p.action === 'create'); const updates = planned.filter(p => p.action === 'update');
      const entity = isCustomer ? 'customer' : 'supplier';
      if (creates.length) {
        await model.createMany({ data: creates.map(p => { const { existingId: _e, ...d } = p.data; return { companyId, ...d }; }) });
        // createMany no devuelve los ids: se leen por RIF para emitir los eventos de integración.
        const made: Array<{ id: string; version: number }> = await model.findMany({ where: { rif: { in: creates.map(p => p.data.rif) } }, select: { id: true, version: true } });
        for (const m of made) await ctx.events.emit({ entity, entityId: m.id, op: 'CREATE', version: m.version });
      }
      for (const p of updates) {
        const { existingId, rif: _r, ...d } = p.data;
        const u = await model.update({ where: { id: existingId }, data: { ...d, version: { increment: 1 } } });
        await ctx.events.emit({ entity, entityId: existingId, op: 'UPDATE', version: u.version });
      }
      return { created: creates.length, updated: updates.length };
    },
  };
}

// ═══════════════════════════ INSTANCIAS (categorías) ═══════════════════════════
const categories: ImportTypeDef = {
  key: 'categories', title: 'Instancias (categorías)', description: 'Jerarquía de instancias. La instancia padre puede estar en el mismo archivo.',
  permission: 'admin:categories:create', supportsExisting: true,
  columns: [c('codigo', 'codigo', 'Código único', 'FRENOS', true), c('nombre', 'nombre', 'Nombre', 'Frenos', true), c('instancia_padre', 'instancia_padre', 'Código de la instancia padre (opcional)', ''), c('margen', 'margen', 'Margen por defecto (%)', '30')],
  async plan(ctx, rows, o) {
    const existing = await ctx.tx.category.findMany({ where: { deletedAt: null }, select: { id: true, code: true } });
    const byCode = new Map(existing.map(x => [x.code.toLowerCase(), x.id])); const inFile = new Set(rows.map(r => v(r, 'codigo').toLowerCase()).filter(Boolean));
    const seen = new Map<string, number>();
    return rows.map(r => {
      const code = v(r, 'codigo'); const p: Planned = { row: r.row, action: 'create', errors: [], warnings: [], data: {}, label: `${code} ${v(r, 'nombre')}`.trim() };
      if (!code) p.errors.push('El código es obligatorio'); else dup(seen, code.toLowerCase(), r.row, p, 'Código');
      const existingId = code ? byCode.get(code.toLowerCase()) : undefined;
      if (!v(r, 'nombre') && !existingId) p.errors.push('El nombre es obligatorio');
      const d: Record<string, any> = { code, existingId, name: v(r, 'nombre') || undefined };
      const parent = v(r, 'instancia_padre');
      if (parent) {
        if (parent.toLowerCase() === code.toLowerCase()) p.errors.push('Una instancia no puede ser su propio padre');
        else if (!byCode.has(parent.toLowerCase()) && !inFile.has(parent.toLowerCase())) p.errors.push(`La instancia padre «${parent}» no existe`);
        else d.parentCode = parent;
      }
      if (v(r, 'margen')) { const n = parseDecimal(v(r, 'margen')); if (n === null || Number(n) < 0 || Number(n) > 100) p.errors.push('margen debe estar entre 0 y 100'); else d.marginDefault = n; }
      p.data = d;
      if (!p.errors.length) actionFor(!!existingId, o, p);
      return p;
    });
  },
  async apply(ctx, planned) {
    const { tx, companyId } = ctx;
    const ids = new Map((await tx.category.findMany({ select: { id: true, code: true } })).map(x => [x.code.toLowerCase(), x.id]));
    let created = 0, updated = 0;
    for (const p of planned) { // paso 1: crear/actualizar sin padre
      const { existingId, parentCode: _p, code, ...d } = p.data;
      if (p.action === 'create') { const r = await tx.category.create({ data: { companyId, code, ...d, name: d.name! } }); ids.set(code.toLowerCase(), r.id); created++; }
      else if (p.action === 'update') { await tx.category.update({ where: { id: existingId }, data: d }); updated++; }
    }
    for (const p of planned) { // paso 2: enlazar padres (ya existen todos)
      if (p.action === 'skip' || !p.data.parentCode) continue;
      await tx.category.update({ where: { id: ids.get(p.data.code.toLowerCase())! }, data: { parentId: ids.get(p.data.parentCode.toLowerCase())! } });
    }
    return { created, updated };
  },
};

// ═══════════════════════════ UBICACIONES ═══════════════════════════
const locations: ImportTypeDef = {
  key: 'locations', title: 'Ubicaciones', description: 'Ubicaciones del almacén (vitrina, estante, pasillo…) para asignar a los productos.',
  permission: 'admin:locations:create', supportsExisting: true,
  columns: [c('codigo', 'codigo', 'Código único (máx. 30)', 'P1-E6-P4', true), c('nombre', 'nombre', 'Nombre', 'Pasillo 1, estante 6, piso 4', true), c('activo', 'activo', SI_NO + ' (por defecto SI)', 'SI')],
  async plan(ctx, rows, o) {
    const existing = await ctx.tx.location.findMany({ where: { deletedAt: null }, select: { id: true, code: true } });
    const byCode = new Map(existing.map(x => [x.code.toLowerCase(), x.id]));
    const seen = new Map<string, number>();
    return rows.map(r => {
      const code = v(r, 'codigo'); const p: Planned = { row: r.row, action: 'create', errors: [], warnings: [], data: {}, label: `${code} ${v(r, 'nombre')}`.trim() };
      if (!code) p.errors.push('El código es obligatorio'); else if (code.length > 30) p.errors.push('Código demasiado largo (máx. 30)'); else dup(seen, code.toLowerCase(), r.row, p, 'Código');
      const existingId = code ? byCode.get(code.toLowerCase()) : undefined;
      if (!v(r, 'nombre') && !existingId) p.errors.push('El nombre es obligatorio');
      const d: Record<string, any> = { code, existingId, name: v(r, 'nombre') || undefined };
      const act = parseBool(v(r, 'activo'), true); if (act === null) p.errors.push('activo debe ser SI o NO'); else if (v(r, 'activo')) d.isActive = act;
      p.data = d;
      if (!p.errors.length) actionFor(!!existingId, o, p);
      return p;
    });
  },
  async apply(ctx, planned) {
    const { tx, companyId } = ctx;
    let created = 0, updated = 0;
    for (const p of planned) {
      const { existingId, code, ...d } = p.data;
      if (p.action === 'create') { await tx.location.create({ data: { companyId, code, ...d, name: d.name! } }); created++; }
      else if (p.action === 'update') { await tx.location.update({ where: { id: existingId }, data: d }); updated++; }
    }
    return { created, updated };
  },
};

// ═══════════════════════════ EXISTENCIAS INICIALES ═══════════════════════════
const openingStock: ImportTypeDef = {
  key: 'opening-stock', title: 'Existencias iniciales', description: 'Carga inicial de inventario: crea y confirma un cargo («Carga inicial») por depósito, con costo en la moneda de valoración. Productos por serial: indique los seriales.',
  permission: 'inventory:charges:confirm', supportsExisting: false,
  columns: [
    c('sku', 'sku', 'SKU de un producto existente', 'PAS-001', true), c('deposito', 'deposito', 'Código del depósito', 'PRINCIPAL', true), c('cantidad', 'cantidad', 'Cantidad (no aplica a productos por serial)', '10'),
    c('costo_unitario', 'costo_unitario', 'Costo unitario en la moneda de valoración de la empresa', '5,25', true), c('lote', 'lote', 'Lote (productos por lote)', ''), c('vencimiento', 'vencimiento', 'Vencimiento AAAA-MM-DD (si el producto lo maneja)', ''),
    c('seriales', 'seriales', 'Seriales separados por coma, | o ; (productos por serial)', 'S001;S002;S003'),
  ],
  async plan(ctx, rows) {
    const { tx } = ctx;
    const [prods, whs, stock] = await Promise.all([tx.product.findMany({ where: { deletedAt: null } }), tx.warehouse.findMany({ where: { deletedAt: null, isActive: true } }), tx.inventoryStock.findMany({ where: { NOT: { quantity: 0 } }, select: { productId: true } })]);
    const prodBy = new Map(prods.map(p => [p.sku.toLowerCase(), p])); const whBy = new Map(whs.map(w => [w.code.toLowerCase(), w]));
    const withStock = new Set(stock.map(s => s.productId));
    const seen = new Map<string, number>(); const seenSerial = new Map<string, number>();
    const serialsExisting = new Set((await tx.productSerial.findMany({ where: { status: 'IN_STOCK' }, select: { productId: true, serialNo: true } })).map(s => `${s.productId}|${s.serialNo}`));
    return rows.map(r => {
      const p: Planned = { row: r.row, action: 'create', errors: [], warnings: [], data: {}, label: `${v(r, 'sku')} @ ${v(r, 'deposito')}` };
      const prod = prodBy.get(v(r, 'sku').toLowerCase()); const wh = whBy.get(v(r, 'deposito').toLowerCase());
      if (!v(r, 'sku')) p.errors.push('El SKU es obligatorio'); else if (!prod) p.errors.push(`El producto «${v(r, 'sku')}» no existe (impórtelo antes)`);
      else if (prod.isService) p.errors.push('Un servicio no tiene existencias');
      if (!v(r, 'deposito')) p.errors.push('El depósito es obligatorio'); else if (!wh) p.errors.push(`El depósito «${v(r, 'deposito')}» no existe o está inactivo`);
      const cost = parseDecimal(v(r, 'costo_unitario')); if (cost === null || Number(cost) < 0) p.errors.push('costo_unitario no es un número válido');
      const d: Record<string, any> = { productId: prod?.id, warehouseId: wh?.id, unitCost: cost };
      if (prod && prod.trackingMode === 'SERIAL') {
        const serials = splitList(v(r, 'seriales'));
        if (!serials.length) p.errors.push('El producto se controla por seriales: indique los seriales');
        for (const s of serials) { dup(seenSerial, `${prod.id}|${s}`, r.row, p, `Serial ${s}`); if (serialsExisting.has(`${prod.id}|${s}`)) p.errors.push(`El serial ${s} ya está en existencia`); }
        d.serials = serials;
      } else {
        const q = parseDecimal(v(r, 'cantidad')); if (q === null || Number(q) <= 0) p.errors.push('cantidad debe ser mayor que cero'); else d.quantity = q;
        if (v(r, 'seriales')) p.errors.push('El producto no se controla por seriales');
        if (prod?.trackingMode === 'LOT') {
          if (!v(r, 'lote')) p.errors.push('El producto se controla por lotes: indique el lote'); else d.lotNo = v(r, 'lote');
          if (prod.hasExpiry) { if (!/^\d{4}-\d{2}-\d{2}$/.test(v(r, 'vencimiento'))) p.errors.push('El producto requiere vencimiento (AAAA-MM-DD)'); else d.expiryDate = v(r, 'vencimiento'); }
        }
      }
      if (prod && wh) dup(seen, `${prod.id}|${wh.id}|${v(r, 'lote')}`, r.row, p, 'Producto/depósito/lote');
      if (prod && withStock.has(prod.id)) p.warnings.push('El producto ya tiene existencias: la carga se SUMA y recalcula el costo promedio');
      p.data = d;
      return p;
    });
  },
  async apply(ctx, planned) {
    const byWh = new Map<string, Planned[]>();
    for (const p of planned) byWh.set(p.data.warehouseId, [...(byWh.get(p.data.warehouseId) ?? []), p]);
    const reason = await ctx.tx.movementReason.findFirst({ where: { code: 'CAR-INI', deletedAt: null } });
    let docs = 0;
    for (const [warehouseId, list] of byWh) {
      const doc = await ctx.docs.create('CHARGE', {
        warehouseId, reasonId: reason?.id ?? null, notes: 'Carga inicial (importación)',
        lines: list.map(p => ({
          productId: p.data.productId, unitCost: p.data.unitCost,
          ...(p.data.serials ? { serials: p.data.serials } : { quantity: p.data.quantity }),
          ...(p.data.lotNo ? { lotNo: p.data.lotNo } : {}), ...(p.data.expiryDate ? { expiryDate: p.data.expiryDate } : {}),
        })),
      });
      await ctx.docs.confirm('CHARGE', doc.id);
      docs++;
    }
    return { created: planned.length, updated: 0, note: `${docs} documento(s) de carga inicial confirmados` };
  },
};

// ═══════════════════════════ INVENTARIO (sincronización recurrente) ═══════════════════════════
const normName = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const whCodeOf = (name: string) => normName(name).replace(/ /g, '_').toUpperCase().slice(0, 20) || 'DEPOSITO';

/**
 * Archivo de inventario del cliente (p. ej. «INVENTARIO ELECTRO SUR.xlsx»), que se vuelve a subir cada vez que cambia:
 * una hoja por depósito, columnas CODIGO · DESCRIPCION · MARCA · CANTIDAD · Precio_Vta. Idempotente: subir el mismo
 * archivo dos veces no cambia nada. Lo que no aparece en el archivo no se toca.
 */
const inventorySync: ImportTypeDef = {
  key: 'inventory-sync', title: 'Inventario (sincronización)', allSheets: true, supportsExisting: true,
  description: 'Se puede subir una y otra vez. Una sola hoja con CODIGO · DESCRIPCION · MARCA · CANTIDAD · Precio_Vta. Agrega los productos nuevos y lleva la existencia de cada código a la CANTIDAD del archivo mediante un ajuste de inventario (queda en el kardex); los productos que no aparecen en el archivo no se tocan. Precio_Vta (USD, mayor que cero) actualiza solo la Lista 1 (predeterminada) y de ahí se recalculan las listas derivadas en Bs (precio 1 + % × tasa BCV del día). Se usa el depósito principal salvo que haya columna «deposito» (o varias hojas: cada hoja es un depósito). Con «Si ya existe: actualizar» también se actualizan nombre y marca. Un código repetido suma sus cantidades.',
  permission: 'inventory:adjustments:confirm',
  columns: [
    c('codigo', 'codigo', 'Código del producto (SKU)', '69-8317', true), c('descripcion', 'descripcion', 'Nombre del producto (obligatorio para productos nuevos)', 'CARBONERA ARRANQUE FORD LASER', true),
    c('marca', 'marca', 'Marca (opcional, máx. 80)', 'MOTTA'), c('cantidad', 'cantidad', 'Existencia contada; el sistema queda con esta cantidad (vacío = 0)', '4', true),
    c('precio_vta', 'precio_vta', 'Precio de venta en USD para la Lista 1 (0 o vacío = no cambia)', '12,50'),
    c('deposito', 'deposito', 'Opcional: código o nombre del depósito (por defecto, el principal)', 'PRINCIPAL'),
  ],
  async plan(ctx, rows, o) {
    const { tx } = ctx;
    const [prods, whs, units, taxes, lists, stock] = await Promise.all([
      tx.product.findMany({ where: { deletedAt: null } }), tx.warehouse.findMany({ where: { deletedAt: null } }), tx.unit.findMany({ where: { deletedAt: null } }),
      tx.tax.findMany({ where: { deletedAt: null, isActive: true, validFrom: { lte: new Date(ctx.today) } }, orderBy: { validFrom: 'desc' } }),
      tx.priceList.findMany({ where: { deletedAt: null, isDefault: true } }), tx.inventoryStock.findMany({ select: { productId: true, warehouseId: true, quantity: true } }),
    ]);
    const prodBy = new Map(prods.map(p => [p.sku.toLowerCase(), p]));
    const whBy = new Map<string, { id: string; name: string }>();
    for (const w of whs) { whBy.set(normName(w.code), w); whBy.set(normName(w.name), w); }
    const activeWhs = whs.filter(w => w.isActive).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const mainWh = activeWhs.find(w => w.code.toUpperCase() === 'PRINCIPAL') ?? activeWhs[0];
    const unit = units.find(u => u.code.toUpperCase() === 'UND') ?? units[0];
    const tax = taxes.find(t => t.code.toUpperCase() === 'IVA_GENERAL');
    const sysQty = new Map(stock.map(s => [`${s.productId}|${s.warehouseId}`, Number(s.quantity)]));
    const defaultList = lists[0];
    const curPrice = new Map<string, number>(); // precio vigente por producto en la lista predeterminada
    if (defaultList) for (const pp of await tx.productPrice.findMany({ where: { priceListId: defaultList.id, validFrom: { lte: new Date(ctx.today) } }, orderBy: { validFrom: 'desc' } })) if (!curPrice.has(pp.productId)) curPrice.set(pp.productId, Number(pp.price));
    const defCur = defaultList ? await tx.currency.findUnique({ where: { id: defaultList.currencyId } }) : null;
    const first = new Map<string, Planned>(); // `${depósito}|${sku}` → fila que acumula
    const sheetsNoted = new Set<string>();
    let curNoted = false;

    const out = rows.map(r => {
      const sku = v(r, 'codigo'), name = v(r, 'descripcion'), depName = v(r, 'deposito') || mainWh?.name || '';
      const p: Planned = { row: r.row, action: 'create', errors: [], warnings: [], data: {}, label: `${sku} · ${depName || '—'}${name ? ' · ' + name.slice(0, 60) : ''}` };
      if (!sku) p.errors.push('El código es obligatorio'); else if (sku.length > 60) p.errors.push('Código demasiado largo (máx. 60)');
      if (!depName) p.errors.push('No hay depósito: cree uno o indique la columna deposito');
      const wh = depName ? whBy.get(normName(depName)) : undefined;
      const whKey = normName(depName);
      if (depName && !wh && !sheetsNoted.has(whKey)) { sheetsNoted.add(whKey); p.warnings.push(`El depósito «${depName}» no existe: se creará con código ${whCodeOf(depName)}`); }
      const prod = sku ? prodBy.get(sku.toLowerCase()) : undefined;
      if (!name && !prod) p.errors.push('La descripción es obligatoria para un producto nuevo');
      if (v(r, 'marca').length > 80) p.errors.push('La marca no puede pasar de 80 caracteres');
      let qty = 0;
      if (!v(r, 'cantidad')) p.warnings.push('Cantidad vacía: se toma como 0');
      else { const n = parseDecimal(v(r, 'cantidad')); if (n === null || Number(n) < 0) p.errors.push('cantidad no es un número válido'); else qty = Number(n); }
      let price: string | undefined;
      if (defCur && defCur.code !== 'USD' && v(r, 'precio_vta') && !curNoted) { curNoted = true; p.warnings.push(`La Lista 1 (${defaultList!.name}) está en ${defCur.code}, no en USD: Precio_Vta se guardará en esa moneda`); }
      if (v(r, 'precio_vta')) { const n = parseDecimal(v(r, 'precio_vta')); if (n === null || Number(n) < 0) p.errors.push('precio_vta no es un número válido'); else if (Number(n) > 0) { if (!defaultList) p.errors.push('No hay lista de precios predeterminada'); else price = n; } }
      if (prod) {
        if (prod.isService) p.errors.push('Es un servicio: no tiene existencias');
        else if (prod.trackingMode !== 'NONE') p.errors.push('El producto se controla por lote/serial: ajústelo desde Inventario');
        else if (!prod.isActive) p.errors.push('El producto está inactivo');
      } else if (!unit) p.errors.push('No hay unidades de medida configuradas');

      const key = `${whKey}|${sku.toLowerCase()}`;
      const head = sku && depName ? first.get(key) : undefined;
      if (head) { // repetido en la misma hoja: suma a la primera fila
        head.data.quantity += qty; head.data.merged += 1;
        if (price && !head.data.price) head.data.price = price;
        head.warnings = head.warnings.filter(w => !w.startsWith('Código repetido')); head.warnings.push(`Código repetido en el archivo (${head.data.merged + 1} filas): se suman las cantidades → ${head.data.quantity}`);
        p.action = 'skip'; p.warnings.push(`Repetido: su cantidad (${qty}) se sumó a la fila ${head.row}`);
        return p;
      }
      const sys = prod && wh ? (sysQty.get(`${prod.id}|${wh.id}`) ?? 0) : 0;
      p.data = { sku, name, brand: v(r, 'marca') || undefined, price, quantity: qty, merged: 0, productId: prod?.id, warehouseId: wh?.id, warehouseName: depName, sys, unitId: unit?.id, taxId: tax?.id };
      if (sku && depName) first.set(key, p);
      return p;
    });

    // Acción final por fila (ya con cantidades acumuladas)
    const willCreate = new Set<string>(); // un mismo código nuevo en varias hojas se crea una sola vez
    for (const p of out) {
      if (p.action === 'skip' || p.errors.length) continue;
      const d = p.data; const prod = d.productId ? prods.find(x => x.id === d.productId) : undefined;
      d.needsStock = d.quantity !== d.sys;
      const masterChange = !!prod && o.onExisting === 'update' && ((d.name && d.name !== prod.name) || (d.brand && d.brand !== prod.brand));
      d.updateMaster = masterChange;
      if (!prod && willCreate.has(d.sku.toLowerCase())) { d.followsNew = true; p.action = d.needsStock || d.price ? 'update' : 'skip'; }
      else if (!prod) { willCreate.add(d.sku.toLowerCase()); p.action = 'create'; if (!tax) p.warnings.push('Sin impuesto IVA_GENERAL configurado: el producto se crea sin impuesto'); }
      else {
        if (d.price && curPrice.get(prod.id) === Number(d.price)) d.price = undefined; // sin cambio de precio
        p.action = d.needsStock || masterChange || d.price ? 'update' : 'skip';
      }
      if (d.needsStock) p.label += `  (existencia ${d.sys} → ${d.quantity})`;
    }
    return out;
  },
  async apply(ctx, planned) {
    const { tx, companyId, userId } = ctx;
    // 1. depósitos nuevos
    const newWh = new Map<string, string>(); // clave normalizada → id
    for (const p of planned) if (!p.data.warehouseId) {
      const k = normName(p.data.warehouseName);
      if (!newWh.has(k)) {
        const code = whCodeOf(p.data.warehouseName);
        const w = await tx.warehouse.create({ data: { companyId, code, name: p.data.warehouseName.trim().slice(0, 120) } });
        newWh.set(k, w.id);
      }
    }
    const whId = (p: Planned) => (p.data.warehouseId ?? newWh.get(normName(p.data.warehouseName))) as string;

    // 2. productos nuevos
    const creates = planned.filter(p => p.action === 'create');
    const idBySku = new Map<string, string>();
    if (creates.length) {
      const made = await tx.product.createManyAndReturn({ data: creates.map(p => ({ companyId, sku: p.data.sku, name: p.data.name, brand: p.data.brand ?? null, unitId: p.data.unitId, taxId: p.data.taxId ?? null, createdBy: userId, updatedBy: userId })) });
      made.forEach(x => idBySku.set(x.sku, x.id));
    }
    const productIdOf = (p: Planned) => (p.data.productId ?? idBySku.get(p.data.sku)) as string;

    // 3. datos de productos existentes
    let updated = 0;
    for (const p of planned.filter(x => x.action === 'update')) {
      if (p.data.updateMaster) await tx.product.update({ where: { id: p.data.productId }, data: { ...(p.data.name ? { name: p.data.name } : {}), ...(p.data.brand ? { brand: p.data.brand } : {}), updatedBy: userId, version: { increment: 1 } } });
      if (!p.data.followsNew) updated++;
    }
    // 4. precios
    const defaultList = await tx.priceList.findFirst({ where: { deletedAt: null, isDefault: true } });
    if (defaultList) for (const p of planned.filter(x => x.data.price)) {
      const productId = productIdOf(p); const validFrom = new Date(ctx.today);
      await tx.productPrice.upsert({
        where: { companyId_productId_priceListId_validFrom: { companyId, productId, priceListId: defaultList.id, validFrom } },
        update: { price: p.data.price, createdBy: userId }, create: { companyId, productId, priceListId: defaultList.id, price: p.data.price, validFrom, createdBy: userId },
      });
    }
    // 5. existencias: un ajuste de inventario por depósito, solo con las líneas que cambian
    const byWh = new Map<string, Planned[]>();
    for (const p of planned) if (p.data.needsStock) byWh.set(whId(p), [...(byWh.get(whId(p)) ?? []), p]);
    const reason = await tx.movementReason.findFirst({ where: { code: 'AJU-INV', deletedAt: null } });
    for (const [warehouseId, list] of byWh) {
      const doc = await ctx.docs.create('ADJUSTMENT', { warehouseId, reasonId: reason?.id ?? null, notes: 'Sincronización de inventario (importación)', lines: list.map(p => ({ productId: productIdOf(p), countedQty: String(p.data.quantity) })) });
      await ctx.docs.confirm('ADJUSTMENT', doc.id);
    }
    const derived = await ctx.products.recomputeDerivedLists(ctx.today);
    const dNote = derived.length ? `; listas derivadas: ${derived.map(d => d.error ? `${d.code} (${d.error})` : `${d.code} ${d.changed} precio(s)`).join(', ')}` : '';
    return { created: creates.length, updated, note: `${byWh.size} ajuste(s) de inventario confirmados (${[...byWh.values()].reduce((a, l) => a + l.length, 0)} líneas)${newWh.size ? `; ${newWh.size} depósito(s) creados` : ''}${dNote}` };
  },
};

// ═══════════════════════════ LISTAS DE PRECIOS ═══════════════════════════
const prices: ImportTypeDef = {
  key: 'prices', title: 'Precios por lista', description: 'Precio de cada producto en una lista de precios (en la moneda de la lista). Si ya hay precio para esa fecha se actualiza; cada cambio queda en el historial.',
  permission: 'admin:products:update', supportsExisting: false,
  columns: [
    c('sku', 'sku', 'SKU de un producto existente', 'PAS-001', true), c('lista', 'lista', 'Código de la lista de precios existente', 'MAYORISTA', true),
    c('precio', 'precio', 'Precio en la moneda de la lista', '25,50', true), c('vigente_desde', 'vigente_desde', 'Fecha AAAA-MM-DD (por defecto hoy)', ''),
  ],
  async plan(ctx, rows) {
    const { tx } = ctx;
    const [prods, lists] = await Promise.all([tx.product.findMany({ where: { deletedAt: null }, select: { id: true, sku: true } }), tx.priceList.findMany({ where: { deletedAt: null }, select: { id: true, code: true } })]);
    const prodBy = new Map(prods.map(x => [x.sku.toLowerCase(), x.id])); const listBy = new Map(lists.map(x => [x.code.toLowerCase(), x.id]));
    const seen = new Map<string, number>();
    return rows.map(r => {
      const p: Planned = { row: r.row, action: 'create', errors: [], warnings: [], data: {}, label: `${v(r, 'sku')} @ ${v(r, 'lista')}` };
      const productId = prodBy.get(v(r, 'sku').toLowerCase()); const priceListId = listBy.get(v(r, 'lista').toLowerCase());
      if (!v(r, 'sku')) p.errors.push('El SKU es obligatorio'); else if (!productId) p.errors.push(`El producto «${v(r, 'sku')}» no existe (impórtelo antes)`);
      if (!v(r, 'lista')) p.errors.push('La lista es obligatoria'); else if (!priceListId) p.errors.push(`La lista de precios «${v(r, 'lista')}» no existe`);
      const price = parseDecimal(v(r, 'precio')); if (price === null || Number(price) < 0) p.errors.push('precio no es un número válido');
      const validFrom = v(r, 'vigente_desde') || ctx.today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) p.errors.push('vigente_desde debe ser AAAA-MM-DD');
      if (productId && priceListId) dup(seen, `${productId}|${priceListId}|${validFrom}`, r.row, p, 'Producto/lista/fecha');
      p.data = { productId, priceListId, price, validFrom };
      return p;
    });
  },
  async apply(ctx, planned) {
    const { tx, companyId } = ctx;
    let created = 0, updated = 0;
    for (const p of planned) {
      const { productId, priceListId, price, validFrom } = p.data;
      const where = { companyId_productId_priceListId_validFrom: { companyId, productId, priceListId, validFrom: new Date(validFrom) } };
      const prev = await tx.productPrice.findUnique({ where });
      await tx.productPrice.upsert({ where, update: { price, createdBy: ctx.userId }, create: { companyId, productId, priceListId, price, validFrom: new Date(validFrom), createdBy: ctx.userId } });
      prev ? updated++ : created++;
    }
    return { created, updated };
  },
};

// ═══════════════════════════ SALDOS INICIALES DE CUENTAS POR COBRAR ═══════════════════════════
const openingReceivables: ImportTypeDef = {
  key: 'receivables-opening', title: 'Saldos iniciales de cuentas por cobrar', description: 'Deudas existentes de clientes (migración). Una fila por documento; monto negativo = saldo a favor del cliente.',
  permission: 'treasury:receivables:create', supportsExisting: false,
  columns: [
    c('rif', 'rif', 'RIF de un cliente existente', 'J-12345678-9', true), c('documento', 'documento', 'Número del documento adeudado', 'F-0001234', true),
    c('emision', 'emision', 'Fecha de emisión AAAA-MM-DD', '2026-01-15', true), c('vencimiento', 'vencimiento', 'AAAA-MM-DD (por defecto emisión + días de crédito del cliente)', ''),
    c('moneda', 'moneda', 'Código de moneda (por defecto VES)', 'VES'), c('monto', 'monto', 'Saldo pendiente (en la moneda indicada)', '1500,00', true),
    c('tasa', 'tasa', 'Tasa de cambio del documento (obligatoria si la moneda no es VES)', ''), c('notas', 'notas', 'Observación opcional', ''),
  ],
  async plan(ctx, rows) {
    const { tx } = ctx;
    const [customers, currencies, existing] = await Promise.all([
      tx.customer.findMany({ where: { deletedAt: null }, select: { id: true, rif: true, creditDays: true } }), ctx.prisma.db.currency.findMany(),
      tx.receivableEntry.findMany({ where: { entryType: 'OPENING', status: { not: 'CANCELLED' } }, select: { customerId: true, documentNo: true } }),
    ]);
    const custBy = new Map(customers.map(x => [formatRif(x.rif), x])); const curBy = new Map(currencies.map(x => [x.code.toLowerCase(), x]));
    const has = new Set(existing.map(e => `${e.customerId}|${e.documentNo.toLowerCase()}`)); const seen = new Map<string, number>();
    const day = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    return rows.map(r => {
      const p: Planned = { row: r.row, action: 'create', errors: [], warnings: [], data: {}, label: `${v(r, 'rif')} ${v(r, 'documento')}` };
      const rif = v(r, 'rif');
      const cust = rif ? custBy.get(isValidRif(rif) ? formatRif(rif) : rif) : undefined;
      if (!rif) p.errors.push('El RIF es obligatorio'); else if (!cust) p.errors.push(`El cliente con RIF «${rif}» no existe (impórtelo antes)`);
      if (!v(r, 'documento')) p.errors.push('El documento es obligatorio');
      if (!day(v(r, 'emision'))) p.errors.push('emision debe ser AAAA-MM-DD');
      if (v(r, 'vencimiento') && !day(v(r, 'vencimiento'))) p.errors.push('vencimiento debe ser AAAA-MM-DD');
      const cur = curBy.get((v(r, 'moneda') || 'VES').toLowerCase()); if (!cur) p.errors.push(`La moneda «${v(r, 'moneda')}» no existe`);
      const amount = parseDecimal(v(r, 'monto')); if (amount === null || Number(amount) === 0) p.errors.push('monto no es un número válido (distinto de cero)');
      let rate = '1';
      if (cur && cur.code !== 'VES') { const t = parseDecimal(v(r, 'tasa')); if (t === null || Number(t) <= 0) p.errors.push('La tasa es obligatoria y positiva para monedas distintas de VES'); else rate = t; }
      if (cust && v(r, 'documento')) { dup(seen, `${cust.id}|${v(r, 'documento').toLowerCase()}`, r.row, p, 'Documento'); if (has.has(`${cust.id}|${v(r, 'documento').toLowerCase()}`)) p.errors.push('Ya existe un saldo inicial con ese documento para el cliente'); }
      let due = v(r, 'vencimiento');
      if (!due && cust && day(v(r, 'emision'))) due = new Date(new Date(v(r, 'emision')).getTime() + cust.creditDays * 86_400_000).toISOString().slice(0, 10);
      if (due && day(v(r, 'emision')) && due < v(r, 'emision')) p.errors.push('El vencimiento no puede ser anterior a la emisión');
      p.data = { customerId: cust?.id, documentNo: v(r, 'documento'), issueDate: v(r, 'emision'), dueDate: due, currencyId: cur?.id, exchangeRate: rate, amount, notes: v(r, 'notas') || null };
      return p;
    });
  },
  async apply(ctx, planned) {
    for (const p of planned) {
      const d = p.data;
      await ctx.tx.receivableEntry.create({
        data: { companyId: ctx.companyId, customerId: d.customerId, entryType: 'OPENING', documentNo: d.documentNo, issueDate: new Date(d.issueDate), dueDate: new Date(d.dueDate), currencyId: d.currencyId, exchangeRate: d.exchangeRate, amount: d.amount, balance: d.amount, status: 'OPEN', notes: d.notes, createdBy: ctx.userId },
      });
    }
    return { created: planned.length, updated: 0 };
  },
};

// ═══════════════════════════ SALDOS INICIALES DE CUENTAS POR PAGAR ═══════════════════════════
const openingPayables: ImportTypeDef = {
  key: 'payables-opening', title: 'Saldos iniciales de cuentas por pagar', description: 'Deudas existentes con proveedores (migración). Una fila por documento; monto negativo = saldo a favor de la empresa.',
  permission: 'treasury:payables:create', supportsExisting: false,
  columns: [
    c('rif', 'rif', 'RIF de un proveedor existente', 'J-12345678-9', true), c('documento', 'documento', 'Número de la factura del proveedor', 'F-0001234', true),
    c('emision', 'emision', 'Fecha de emisión AAAA-MM-DD', '2026-01-15', true), c('vencimiento', 'vencimiento', 'AAAA-MM-DD (por defecto emisión + días de crédito del proveedor)', ''),
    c('moneda', 'moneda', 'Código de moneda (por defecto VES)', 'VES'), c('monto', 'monto', 'Saldo pendiente (en la moneda indicada)', '1500,00', true),
    c('tasa', 'tasa', 'Tasa de cambio del documento (obligatoria si la moneda no es VES)', ''), c('notas', 'notas', 'Observación opcional', ''),
  ],
  async plan(ctx, rows) {
    const { tx } = ctx;
    const [customers, currencies, existing] = await Promise.all([
      tx.supplier.findMany({ where: { deletedAt: null }, select: { id: true, rif: true, creditDays: true } }), ctx.prisma.db.currency.findMany(),
      tx.payableEntry.findMany({ where: { entryType: 'OPENING', status: { not: 'CANCELLED' } }, select: { supplierId: true, documentNo: true } }),
    ]);
    const custBy = new Map(customers.map(x => [formatRif(x.rif), x])); const curBy = new Map(currencies.map(x => [x.code.toLowerCase(), x]));
    const has = new Set(existing.map(e => `${e.supplierId}|${(e.documentNo ?? '').toLowerCase()}`)); const seen = new Map<string, number>();
    const day = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    return rows.map(r => {
      const p: Planned = { row: r.row, action: 'create', errors: [], warnings: [], data: {}, label: `${v(r, 'rif')} ${v(r, 'documento')}` };
      const rif = v(r, 'rif');
      const cust = rif ? custBy.get(isValidRif(rif) ? formatRif(rif) : rif) : undefined;
      if (!rif) p.errors.push('El RIF es obligatorio'); else if (!cust) p.errors.push(`El proveedor con RIF «${rif}» no existe (impórtelo antes)`);
      if (!v(r, 'documento')) p.errors.push('El documento es obligatorio');
      if (!day(v(r, 'emision'))) p.errors.push('emision debe ser AAAA-MM-DD');
      if (v(r, 'vencimiento') && !day(v(r, 'vencimiento'))) p.errors.push('vencimiento debe ser AAAA-MM-DD');
      const cur = curBy.get((v(r, 'moneda') || 'VES').toLowerCase()); if (!cur) p.errors.push(`La moneda «${v(r, 'moneda')}» no existe`);
      const amount = parseDecimal(v(r, 'monto')); if (amount === null || Number(amount) === 0) p.errors.push('monto no es un número válido (distinto de cero)');
      let rate = '1';
      if (cur && cur.code !== 'VES') { const t = parseDecimal(v(r, 'tasa')); if (t === null || Number(t) <= 0) p.errors.push('La tasa es obligatoria y positiva para monedas distintas de VES'); else rate = t; }
      if (cust && v(r, 'documento')) { dup(seen, `${cust.id}|${v(r, 'documento').toLowerCase()}`, r.row, p, 'Documento'); if (has.has(`${cust.id}|${v(r, 'documento').toLowerCase()}`)) p.errors.push('Ya existe un saldo inicial con ese documento para el proveedor'); }
      let due = v(r, 'vencimiento');
      if (!due && cust && day(v(r, 'emision'))) due = new Date(new Date(v(r, 'emision')).getTime() + cust.creditDays * 86_400_000).toISOString().slice(0, 10);
      if (due && day(v(r, 'emision')) && due < v(r, 'emision')) p.errors.push('El vencimiento no puede ser anterior a la emisión');
      p.data = { supplierId: cust?.id, documentNo: v(r, 'documento'), issueDate: v(r, 'emision'), dueDate: due, currencyId: cur?.id, exchangeRate: rate, amount, notes: v(r, 'notas') || null };
      return p;
    });
  },
  async apply(ctx, planned) {
    for (const p of planned) {
      const d = p.data;
      await ctx.tx.payableEntry.create({
        data: { companyId: ctx.companyId, supplierId: d.supplierId, entryType: 'OPENING', documentNo: d.documentNo, issueDate: new Date(d.issueDate), dueDate: new Date(d.dueDate), currencyId: d.currencyId, exchangeRate: d.exchangeRate, amount: d.amount, balance: d.amount, status: 'OPEN', notes: d.notes, },
      });
    }
    return { created: planned.length, updated: 0 };
  },
};


export const IMPORT_TYPES: ImportTypeDef[] = [inventorySync, categories, locations, products, thirdParty('suppliers'), thirdParty('customers'), openingStock, prices, openingReceivables, openingPayables];
export const findImportType = (key: string) => IMPORT_TYPES.find(t => t.key === key);

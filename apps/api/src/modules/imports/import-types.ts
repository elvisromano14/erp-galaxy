import { Prisma } from '@prisma/client';
import { formatRif, isValidRif } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { InventoryDocsService } from '../inventory/inventory-docs.service';
import { parseBool, parseDecimal, splitList } from './import-file';

type Tx = Prisma.TransactionClient;

export interface ImportColumn { key: string; header: string; required?: boolean; help: string; example: string }
export interface ImportOptions { onExisting: 'skip' | 'update' }
export interface ImportCtx { prisma: PrismaService; tx: Tx; companyId: string; userId?: string; docs: InventoryDocsService; today: string }
export interface Planned<T = Record<string, any>> { row: number; action: 'create' | 'update' | 'skip'; errors: string[]; warnings: string[]; data: T; label: string }
export type RawRow = { row: number; values: Record<string, string> };

export interface ImportTypeDef {
  key: string; title: string; description: string;
  /** Además de `admin:import:create`, el usuario necesita este permiso del módulo destino. */
  permission: string;
  columns: ImportColumn[];
  supportsExisting: boolean;
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
    c('es_servicio', 'es_servicio', SI_NO + ' (por defecto NO)', 'NO'), c('stock_minimo', 'stock_minimo', 'Mínimo para reposición', '5'), c('stock_maximo', 'stock_maximo', 'Máximo para reposición', '20'),
    c('codigos_barras', 'codigos_barras', 'Varios separados por coma, | o ;', '7591234567890;7591234567891'), c('codigos_oem', 'codigos_oem', 'Referencias OEM separadas por coma, | o ;', '04465-0K290'),
    c('precio', 'precio', 'Precio en la lista predeterminada (moneda de la lista)', '25,50'), c('activo', 'activo', SI_NO + ' (por defecto SI)', 'SI'),
  ],
  async plan(ctx, rows, o) {
    const { tx } = ctx;
    const [cats, units, taxes, existing, lists] = await Promise.all([
      tx.category.findMany({ where: { deletedAt: null } }), tx.unit.findMany({ where: { deletedAt: null } }),
      tx.tax.findMany({ where: { deletedAt: null, isActive: true, validFrom: { lte: new Date(ctx.today) } }, orderBy: { validFrom: 'desc' } }),
      tx.product.findMany({ where: { deletedAt: null }, select: { id: true, sku: true } }), tx.priceList.findMany({ where: { deletedAt: null, isDefault: true } }),
    ]);
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
          companyId, sku: d.sku, name: d.name, description: d.description ?? null, categoryId: d.categoryId ?? null, unitId: d.unitId, taxId: d.taxId ?? null,
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
      if (creates.length) await model.createMany({ data: creates.map(p => { const { existingId: _e, ...d } = p.data; return { companyId, ...d }; }) });
      for (const p of updates) { const { existingId, rif: _r, ...d } = p.data; await model.update({ where: { id: existingId }, data: { ...d, version: { increment: 1 } } }); }
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


export const IMPORT_TYPES: ImportTypeDef[] = [categories, products, thirdParty('suppliers'), thirdParty('customers'), openingStock, prices, openingReceivables, openingPayables];
export const findImportType = (key: string) => IMPORT_TYPES.find(t => t.key === key);

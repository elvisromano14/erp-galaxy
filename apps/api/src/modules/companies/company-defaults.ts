/** Datos iniciales de cada empresa nueva. Alícuotas y porcentajes: VALIDAR con el contador (erp-v3 §8). */
export const DEFAULT_TAXES = [
  { code: 'IVA_GENERAL', name: 'IVA alícuota general', kind: 'VAT', rate: '16' },
  { code: 'IVA_REDUCIDA', name: 'IVA alícuota reducida', kind: 'VAT', rate: '8' },
  { code: 'IVA_ADICIONAL', name: 'IVA alícuota adicional (suntuarios)', kind: 'VAT', rate: '15' },
  { code: 'EXENTO', name: 'Exento', kind: 'EXEMPT', rate: '0' },
  { code: 'EXONERADO', name: 'Exonerado', kind: 'EXONERATED', rate: '0' },
  { code: 'IGTF', name: 'IGTF (pagos en divisas)', kind: 'IGTF', rate: '3' },
];

export const DEFAULT_UNITS = [
  { code: 'UND', name: 'Unidad' }, { code: 'CAJ', name: 'Caja' }, { code: 'PAR', name: 'Par' },
  { code: 'JGO', name: 'Juego' }, { code: 'KG', name: 'Kilogramo' }, { code: 'LT', name: 'Litro' }, { code: 'MT', name: 'Metro' },
];

export const DEFAULT_REASONS = [
  { code: 'CAR-INI', name: 'Carga inicial', kind: 'CHARGE' },
  { code: 'CAR-DEV', name: 'Devolución / reingreso', kind: 'CHARGE' },
  { code: 'CAR-OTR', name: 'Otros cargos', kind: 'CHARGE' },
  { code: 'DES-DAN', name: 'Mercancía dañada', kind: 'DISCHARGE' },
  { code: 'DES-PER', name: 'Pérdida / faltante', kind: 'DISCHARGE' },
  { code: 'DES-USO', name: 'Uso interno', kind: 'DISCHARGE' },
  { code: 'AJU-INV', name: 'Inventario físico', kind: 'ADJUSTMENT' },
];

export const DEFAULT_PAYMENT_METHODS = [
  { code: 'CASH_VES', name: 'Efectivo Bs', type: 'CASH', requiresReference: false, appliesIgtf: false, currency: 'VES' },
  { code: 'CASH_USD', name: 'Efectivo USD', type: 'CASH', requiresReference: false, appliesIgtf: true, currency: 'USD' },
  { code: 'TRANSFER', name: 'Transferencia', type: 'TRANSFER', requiresReference: true, appliesIgtf: false, currency: 'VES' },
  { code: 'MOBILE_PAYMENT', name: 'Pago móvil', type: 'MOBILE_PAYMENT', requiresReference: true, appliesIgtf: false, currency: 'VES' },
  { code: 'CARD_POS', name: 'Punto de venta', type: 'CARD', requiresReference: true, appliesIgtf: false, currency: 'VES' },
  { code: 'ZELLE', name: 'Zelle', type: 'ZELLE', requiresReference: true, appliesIgtf: true, currency: 'USD' },
  { code: 'CHECK', name: 'Cheque', type: 'CHECK', requiresReference: true, appliesIgtf: false, currency: 'VES' },
  { code: 'WITHHOLDING', name: 'Retención', type: 'WITHHOLDING', requiresReference: true, appliesIgtf: false, currency: 'VES' },
  { code: 'CREDIT', name: 'Crédito', type: 'CREDIT', requiresReference: false, appliesIgtf: false, currency: null },
];

// Informativo en esta fase: el motor de documentos usa su propio registro; estos tipos se activan con ventas.
export const DEFAULT_OPERATION_TYPES = [
  { code: 'COMPRA', name: 'Compra', docType: 'PURCHASE', inventoryEffect: 'IN', affectsPayable: true },
  { code: 'DEV-COMPRA', name: 'Devolución de compra', docType: 'PURCHASE_RETURN', inventoryEffect: 'OUT', affectsPayable: true },
  { code: 'NOTA-ENTREGA', name: 'Nota de entrega', docType: 'DELIVERY_NOTE', inventoryEffect: 'IN', affectsPayable: false },
  { code: 'TRASLADO', name: 'Traslado', docType: 'TRANSFER', inventoryEffect: 'NONE', affectsPayable: false },
  { code: 'CARGO', name: 'Cargo', docType: 'CHARGE', inventoryEffect: 'IN', affectsPayable: false },
  { code: 'DESCARGO', name: 'Descargo', docType: 'DISCHARGE', inventoryEffect: 'OUT', affectsPayable: false },
  { code: 'AJUSTE', name: 'Ajuste de inventario', docType: 'ADJUSTMENT', inventoryEffect: 'NONE', affectsPayable: false },
];

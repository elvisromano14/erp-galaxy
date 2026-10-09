import { describe, expect, it } from 'vitest';
import { applyEntry, applyExit, applyPurchaseReturn, calcDocument, calcIgtf, emptyCost, isValidRif, toBase } from './index';

describe('totales', () => {
  it('ejemplo del documento: 3 × 12,50 con 5 % descuento e IVA 16 %', () => {
    const t = calcDocument([{ quantity: 3, unitPrice: 12.5, discountPct: 5, taxRate: 16 }]);
    expect(t.subtotal.toString()).toBe('35.625');
    expect(t.taxTotal.toString()).toBe('5.7');
    expect(t.total.toString()).toBe('41.325');
  });
  it('separa exento de gravado y agrupa por alícuota', () => {
    const t = calcDocument([
      { quantity: 1, unitPrice: 100, taxRate: 16 },
      { quantity: 1, unitPrice: 50, taxRate: 8 },
      { quantity: 1, unitPrice: 30, taxRate: 0, taxExempt: true },
    ]);
    expect(t.exemptBase.toString()).toBe('30');
    expect(t.byRate.map(g => g.taxRate.toString())).toEqual(['8', '16']);
    expect(t.total.toString()).toBe('200');
  });
  it('conversión a Bs e IGTF', () => {
    expect(toBase('41.325', '36.52').toString()).toBe('1509.189');
    expect(calcIgtf('1000', '3').toString()).toBe('30');
  });
});

describe('costeo promedio (§7.2 / §2.7)', () => {
  const buy = (s = emptyCost()) => {
    const a = applyEntry(s, 10, 5);
    const b = applyEntry(a.state, 10, 7);
    return b.state;
  };
  it('1. compras 10@5 y 10@7 → C = 6', () => {
    expect(buy().avgCost.toString()).toBe('6');
  });
  it('2. venta no cambia C', () => {
    const s = applyExit(buy(), 5);
    expect(s.state.avgCost.toString()).toBe('6');
    expect(s.state.qty.toString()).toBe('15');
    expect(s.unitCost.toString()).toBe('6');
  });
  it('3. devolución de compra de la segunda compra → C = 4', () => {
    const s = applyExit(buy(), 5).state;
    const r = applyPurchaseReturn(s, 10, 7);
    expect(r.state.avgCost.toString()).toBe('4');
    expect(r.state.qty.toString()).toBe('5');
  });
  it('3b. promedio nunca negativo tras devolución', () => {
    const r = applyPurchaseReturn({ qty: D2(10), avgCost: D2(1) }, 5, 9);
    expect(r.state.avgCost.isNegative()).toBe(false);
  });
  it('4. devolución de venta reingresa al costo original', () => {
    const s = applyExit(buy(), 5).state;
    const r = applyEntry(s, 2, 6);
    expect(r.unitCost.toString()).toBe('6');
    expect(r.state.avgCost.toString()).toBe('6');
  });
  it('5. stock negativo: vender 3 con Q=1 y luego comprar 10@8 → C = 8', () => {
    let s = applyEntry(emptyCost(), 1, 5).state;
    s = applyExit(s, 3).state;
    expect(s.qty.toString()).toBe('-2');
    expect(s.avgCost.toString()).toBe('5');
    s = applyEntry(s, 10, 8).state;
    expect(s.avgCost.toString()).toBe('8');
  });
});

describe('RIF', () => {
  it('rechaza formatos inválidos', () => {
    expect(isValidRif('X-123')).toBe(false);
    expect(isValidRif('J-12345678-0')).toBe(false);
  });
  it('acepta RIF con dígito verificador correcto', () => {
    // J-00000000-? calculado: nums=[3,0×8]; sum=3*4=12; 11-(12%11)=10 → 0
    expect(isValidRif('J-00000000-0')).toBe(true);
  });
});

import { D } from './index';
function D2(v: number) { return D(v); }

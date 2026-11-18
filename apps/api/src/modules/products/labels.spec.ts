import { labelPayload, labelsPdf } from './labels';

describe('etiquetas QR', () => {
  it('el QR trae el código en la primera línea (lo lee el escáner de la app) y debajo nombre y marca', () => {
    expect(labelPayload({ sku: '69-8317', name: 'CARBONERA ARRANQUE FORD', brand: 'MOTTA' }).split('\n')).toEqual(['69-8317', 'CARBONERA ARRANQUE FORD', 'Marca: MOTTA']);
    expect(labelPayload({ sku: 'A-1', name: 'Cinta' })).toBe('A-1\nCinta');
  });
  it('genera un PDF con una página por etiqueta', async () => {
    const buf = await labelsPdf([{ sku: 'A-1', name: 'Cinta aislante negra', brand: 'KMD' }, { sku: 'A-2', name: 'Otro' }], { widthMm: 50, heightMm: 30, copies: 2 });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect((buf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(4);
  });
});

describe('etiquetas QR con datos elegidos', () => {
  it('el QR lleva el código primero y luego solo los datos elegidos', () => {
    const p = { sku: 'A-1', name: 'Cinta', brand: 'KMD', lines: [{ label: 'Marca', value: 'KMD' }, { label: 'Precio · Lista 1', value: '$ 2.50' }] };
    expect(labelPayload(p).split('\n')).toEqual(['A-1', 'Marca: KMD', 'Precio · Lista 1: $ 2.50']);
  });
  it('genera el PDF con los datos elegidos', async () => {
    const buf = await labelsPdf([{ sku: 'A-1', name: 'Cinta', lines: [{ label: 'Descripción', value: 'Cinta aislante' }, { label: 'Ubicación', value: 'Pasillo 3' }] }], { widthMm: 50, heightMm: 30, copies: 1 });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});

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

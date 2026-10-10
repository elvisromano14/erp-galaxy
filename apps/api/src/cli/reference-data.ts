/** Datos de referencia globales (monedas y bancos). Verificar vigencia de los códigos bancarios antes de producción. */
export const CURRENCIES = [
  { code: 'VES', name: 'Bolívar', symbol: 'Bs', decimals: 2 },
  { code: 'USD', name: 'Dólar estadounidense', symbol: '$', decimals: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 },
];

// Códigos de 4 dígitos (SUDEBAN). Verificar vigencia antes de producción.
export const BANKS = [
  ['0102', 'Banco de Venezuela'], ['0104', 'Venezolano de Crédito'], ['0105', 'Mercantil'], ['0108', 'Provincial'],
  ['0114', 'Bancaribe'], ['0115', 'Banco Exterior'], ['0128', 'Banco Caroní'], ['0134', 'Banesco'], ['0137', 'Sofitasa'],
  ['0138', 'Banco Plaza'], ['0151', 'BFC Banco Fondo Común'], ['0156', '100% Banco'], ['0157', 'Del Sur'],
  ['0163', 'Banco del Tesoro'], ['0166', 'Banco Agrícola de Venezuela'], ['0168', 'Bancrecer'], ['0169', 'Mi Banco'],
  ['0171', 'Banco Activo'], ['0172', 'Bancamiga'], ['0174', 'Banplus'], ['0175', 'Banco Bicentenario'], ['0177', 'Banfanb'], ['0191', 'BNC'],
];

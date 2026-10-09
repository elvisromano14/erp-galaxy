/** RIF venezolano: prefijo V/E/J/G/P/C + 8 dígitos + dígito verificador. */
const WEIGHTS = [4, 3, 2, 7, 6, 5, 4, 3, 2];
const PREFIX_VALUE: Record<string, number> = { V: 1, E: 2, J: 3, P: 4, G: 5, C: 3 };

export function normalizeRif(raw: string): string {
  return raw.toUpperCase().replace(/[\s.\-]/g, '');
}

export function isValidRif(raw: string): boolean {
  const rif = normalizeRif(raw);
  if (!/^[VEJGPC]\d{9}$/.test(rif)) return false;
  const digits = rif.slice(1, 9).padStart(8, '0');
  const nums = [PREFIX_VALUE[rif[0]], ...digits.split('').map(Number)];
  const sum = nums.reduce((acc, n, i) => acc + n * WEIGHTS[i], 0);
  const check = 11 - (sum % 11);
  const expected = check >= 10 ? 0 : check;
  return expected === Number(rif[9]);
}

export function formatRif(raw: string): string {
  const r = normalizeRif(raw);
  return `${r[0]}-${r.slice(1, 9)}-${r[9]}`;
}

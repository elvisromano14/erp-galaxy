/** Verificación de tipos (se compila en `pnpm test`): si la API cambia de forma incompatible, falla aquí. */
import { createErpClient, unwrap } from './index';

export async function sample() {
  const api = createErpClient({ baseUrl: 'http://localhost:3101', getAccessToken: () => 'token' });

  // ruta + cuerpo válidos
  await api.POST('/api/v1/auth/login', { body: { email: 'a@b.c', password: 'x' } });

  // la consulta de listados acepta sus parámetros
  await api.GET('/api/v1/sales/orders', { params: { query: { page: 1, limit: 20 } } });

  // un cuerpo de pedido necesita cliente y moneda
  await api.POST('/api/v1/sales/orders', { body: { customerId: 'x', currencyId: 'y', lines: [{ productId: 'p', quantity: '1' }] } });

  // @ts-expect-error la ruta no existe
  await api.GET('/api/v1/no-existe');

  // @ts-expect-error falta el campo obligatorio `password`
  await api.POST('/api/v1/auth/login', { body: { email: 'a@b.c' } });

  const r = await unwrap<{ id: string }[]>(api.GET('/api/v1/sales/orders', {}));
  return r.data[0]?.id;
}

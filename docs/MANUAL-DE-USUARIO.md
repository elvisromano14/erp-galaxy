# Mini ERP — Manual de usuario

Sistema multiempresa para **inventario, compras, ventas, facturación, tesorería e impuestos** (Venezuela: IVA, IGTF, retenciones, bolívares y moneda extranjera).
Este manual explica cada pantalla y cada flujo en el orden en que se usan. Los nombres entre «comillas» o en **negrita** son los que ve en el menú.

> **Aviso fiscal importante.** La numeración de las facturas y notas es **interna y provisional** (el PDF lo indica al pie: «Documento sin validez fiscal»).
> Hasta conectar una imprenta digital o una máquina fiscal, los documentos **no** sustituyen a una factura fiscal. Los porcentajes de IVA, IGTF y retenciones
> y los formatos de libros son **de referencia**: deben ser validados por el contador de cada empresa (ver sección 14).

---

## 1. Conceptos básicos

| Concepto | Qué es |
|---|---|
| **Cliente** | El administrador de una empresa. Lo crea el administrador global (nombre, correo, clave y empresa) y solo entra a la empresa que se le asignó. |
| **Empresa** | La entidad con RIF propio. **Todos los datos (productos, documentos, bancos…) pertenecen a una empresa** y nunca se mezclan con otra. |
| **Usuario** | Persona que entra al sistema. Puede tener acceso a una o varias empresas, con un **rol** en cada una. |
| **Rol** | Conjunto de permisos (Administrador, Gerente, Vendedor, Cajero, Contador, Compras, Almacenista o roles propios). |
| **Administrador global** | Dueño de la plataforma (admin ERP): ve todas las empresas y es el único que crea empresas y clientes. |

Cada pantalla solo aparece en el menú si su rol tiene permiso. Si una opción no aparece, pida acceso a su administrador.

## 2. Entrar al sistema

1. Escriba su correo y contraseña en la pantalla de inicio de sesión.
2. Si tiene acceso a más de una empresa, elija la empresa con la que va a trabajar. Puede cambiar de empresa en cualquier momento desde el menú de su usuario (arriba a la derecha).
3. **Cerrar sesión** está en el mismo menú. Por seguridad la sesión se renueva sola mientras trabaja; si se vence, el sistema le pedirá entrar de nuevo.

Reglas de seguridad: 5 intentos fallidos bloquean la cuenta 15 minutos; las contraseñas tienen mínimo 10 caracteres. Para cambiar su contraseña use el menú de su usuario.

## 3. Puesta en marcha de una empresa nueva (lista de verificación)

Hágalo en este orden; cada paso se explica en su sección.

1. **Configuración → Empresa**: razón social, RIF, dirección fiscal, moneda base (Bs) y de valoración (USD), y marque si es *contribuyente especial*, *agente de retención de IVA* y *agente de percepción de IGTF*. Active las funciones opcionales que necesite: **lotes**, **vencimientos** y **seriales**.
2. **Administración → Monedas** y **Factor cambiario**: verifique VES/USD/EUR y cargue/sincronice la tasa del día (sección 4.2).
3. **Administración → Impuestos**: revise las alícuotas (con su contador).
4. **Administración → Depósitos**, **Instancias** (categorías), **Unidades**.
5. **Administración → Bancos y cuentas bancarias** y **Instrumentos de pago** (transferencia, efectivo, pago móvil, divisas, retención…).
6. **Administración → Proveedores, Clientes, Vendedores, Zonas, Listas de precios**.
7. **Administración → Productos** (o **Configuración → Importar datos** para cargarlos de golpe).
8. Existencias iniciales: importación «Existencias iniciales» o un **Cargo** de inventario.
9. Saldos iniciales de deudas: importación de **cuentas por cobrar / por pagar** (sección 11).
10. **Configuración → Usuarios y Roles**: cree los usuarios y asígneles rol.
11. **Configuración → Numeración**: ajuste prefijos y el próximo número de cada documento si migra desde otro sistema.

## 4. Catálogos (Administración)

Todos los catálogos tienen el mismo comportamiento: lista con búsqueda y paginación, botón **Nuevo**, clic en una fila para editar y baja lógica (los datos dados de baja no se borran, quedan inactivos).

### 4.1 Productos
Código (SKU) único, nombre, instancia, unidad, impuesto por defecto, mínimos y máximos de existencia, **control** (sin control / por lote / por serial), si es servicio, códigos de barras, referencias OEM/equivalentes y **precios por lista** (con historial: cada cambio queda registrado con su fecha de vigencia).
- **Servicios** no tienen existencias ni costo.
- **Por serial**: cada unidad lleva su número y su propio costo de entrada; **por lote**: se maneja lote y (opcional) fecha de vencimiento con salida FEFO (primero vence, primero sale).

### 4.2 Monedas y factor cambiario
- **Factor cambiario** guarda la tasa de cada día. Hay dos orígenes: **BCV** (se sincroniza solo cada 2 horas con DolarApi y también con el botón «Sincronizar BCV ahora») y **manual por empresa** (una tasa manual solo vale para su empresa y prevalece sobre la del BCV de la misma fecha).
- Si falta la tasa de una fecha, los documentos en moneda extranjera no se pueden registrar: cárguela primero.

### 4.3 Terceros
- **Proveedores y Clientes**: RIF (se valida y normaliza a `J-12345678-9`), razón social, tipo de persona, **porcentaje de retención de IVA**, días de crédito, **límite de crédito** (clientes; 0 = sin límite), lista de precios y vendedor (clientes).
- **Vendedores**: pueden vincularse a un usuario. Un vendedor sin permiso de ver todo solo ve **sus** documentos.

### 4.4 Bancos, cuentas e instrumentos de pago
- **Cuentas bancarias**: banco, número, moneda, saldo inicial y **límite de sobregiro** (0 = no puede quedar en negativo). Las cajas son cuentas de tipo «Caja».
- **Instrumentos de pago**: tipo (efectivo, transferencia, pago móvil, tarjeta, Zelle, cheque, **retención**, crédito), si exige referencia y si **aplica IGTF** (pagos en divisas).

### 4.5 Listas de precios y actualización masiva
**Administración → Actualizar precios** cambia los precios de una lista por **porcentaje**, **margen sobre costo** o **precio fijo**, con vista previa obligatoria antes de aplicar. Puede filtrar por instancia y tomar como base otra lista.

## 5. Inventario

### 5.1 Consultas
- **Existencias**: por producto y depósito, con reservado y disponible.
- **Kardex**: movimientos de un producto con saldo y costo promedio. Es de **solo inserción**: nada se edita ni se borra; las anulaciones generan movimientos de reverso.
- **Inventario valorizado**: valor actual o a una fecha.
- **Seriales**: una fila por unidad con su estado (en existencia, vendido, devuelto, desincorporado), ubicación e historial.

### 5.2 Documentos de inventario
Todos siguen el ciclo **Borrador → Confirmado → (Anulado)**. Solo los borradores se editan o eliminan; lo confirmado se corrige anulando (con motivo).
- **Cargo**: entrada con costo (en la moneda de valoración). Calcula el **costo promedio ponderado**.
- **Descargo**: salida a costo promedio. No permite dejar el saldo negativo salvo que el depósito lo autorice, y **no puede consumir lo reservado** por pedidos o presupuestos.
- **Traslado**: entre depósitos, sin cambiar el costo.
- **Ajuste de inventario**: contra un conteo físico (hay una **hoja de conteo** para imprimir). Sobrantes entran al costo promedio; faltantes salen.
- **Ajuste de costo**: cambia el costo promedio de un producto.
- **Períodos**: cierre mensual; un período cerrado no admite movimientos.

En productos por serial indique **un serial por línea** (uno por renglón, o separados por coma); la cantidad se calcula sola.

## 6. Compras

Flujo completo: **Cotización → Orden de compra → Nota de entrega → Compra (factura del proveedor)**, con devoluciones.

1. **Cotizaciones** (compras): se envían, y se aceptan o rechazan; una aceptada se convierte en orden.
2. **Órdenes de compra**: confirme y use **Recibir** para registrar recepciones **parciales o totales**; cada recepción genera una **nota de entrega** que ya **entra al inventario**.
3. **Notas de entrega**: use «Facturar» para crear la **compra** con lo no facturado.
4. **Compras**: exige el número de factura del proveedor y su número de control. Al confirmar, entra al inventario lo que no entró por nota de entrega y nace la **cuenta por pagar** (a crédito) o queda pagada (de contado).
5. **Devoluciones** (de notas o de compras): se crean desde el documento origen con «Crear devolución»; salen al **costo original** y reducen la cuenta por pagar.
6. **Retención de IVA / ISLR**: en una compra a crédito aparece el botón **Registrar retención** (sección 10.2).

Cada documento muestra su origen y sus derivados con enlaces, y la trazabilidad es por línea (no se puede recibir ni devolver más de lo disponible).

## 7. Ventas

### 7.1 Cotización → Presupuesto → Pedido
- **Cotización de venta**: Enviar → Aceptar/Rechazar. Vence en su fecha de vigencia (se marca «Vencida» automáticamente).
- **Presupuesto**: se confirma y puede **reservar existencias**.
- **Pedido**: se confirma y puede **reservar existencias**; los pedidos a crédito validan el **límite de crédito** del cliente (pedidos pendientes + cuentas por cobrar abiertas). Quien tenga el permiso especial puede confirmar «autorizando exceso de crédito».
- Cada conversión crea el documento siguiente en borrador, enlazado línea a línea.

**Precios**: si deja el precio en blanco, el sistema lo toma de la lista indicada, la del cliente o la predeterminada (convertido a la moneda del documento a la tasa del día). También puede escribir el precio a mano.

**Reservas**: al confirmar con «Reservar existencias» se aparta la cantidad en el depósito; se libera al convertir, anular o facturar. Otros descargos no pueden consumir lo reservado.

**Visibilidad**: los vendedores solo ven sus propios documentos, salvo que su rol incluya «ver todos».

### 7.2 Facturas
Cree la factura **desde un pedido** (botón **Facturar**; admite facturación parcial) o **directamente** (Ventas → Facturas → Nuevo). Indique depósito y, para productos por serial, los seriales que se venden.
- **Emitir factura**: asigna número de factura y de control (provisionales), **descarga el inventario** (a costo promedio; cada serial a su propio costo) y:
  - **Contado**: se abre una ventana para registrar los **pagos** (varios instrumentos y monedas). Los pagos deben **cuadrar con el total más el IGTF** (3 % de lo pagado en divisas con instrumentos que lo aplican, si la empresa es agente de percepción de IGTF). Cada pago entra a la cuenta bancaria/caja elegida.
  - **Crédito**: nace la **cuenta por cobrar** con su vencimiento (fecha + días de crédito).
- **PDF** y **Ticket**: botones en la factura emitida. El PDF A4 muestra datos fiscales, líneas, base imponible e IVA por alícuota, IGTF, total en la moneda y en Bs, y pagos; el **ticket** es de 80 mm para impresora térmica.
- **Anular factura**: revierte inventario, pagos y cuenta por cobrar. No se puede si ya tiene **cobros** o **notas de crédito** aplicadas. *(Con el contador defina cuándo la ley exige nota de crédito en lugar de anulación.)*

### 7.3 Notas de crédito y de débito
- **Nota de crédito** (botón en la factura emitida): devolución total o parcial; el producto **reingresa al costo original** (mismos lotes/seriales vendidos) y reduce o compensa la cuenta por cobrar. Si la factura ya estaba pagada, puede marcar **«Devolver el dinero»** y elegir la cuenta de donde sale; si no, queda **saldo a favor** del cliente.
- **Nota de débito**: cargo adicional (intereses, ajuste, gastos) con concepto y monto; aumenta la cuenta por cobrar.
- Las notas no se editan ni se anulan: se corrigen con otro documento.

## 8. Tesorería

### 8.1 Cuentas por cobrar y cobros
- **Cuentas por cobrar** lista todo lo que los clientes deben (facturas, notas de débito, saldos iniciales).
- **Cobros a clientes → Nuevo**: elija el cliente, vea sus documentos abiertos, escriba cuánto aplica a cada uno (botón «Todo») y registre el cobro con instrumento, moneda y cuenta. Admite **cobros parciales**, **moneda distinta** a la del documento (convierte con la tasa del día) y **compensar notas de crédito** (monto negativo). Si el instrumento es en divisas y aplica IGTF, el cliente entrega lo aplicado **más 3 %**.
- Un instrumento de tipo **Retención** registra la retención entregada por el cliente **sin mover banco**.
- **Anular** un cobro restituye el saldo y contra-asienta el banco (no se puede si ya fue conciliado).

### 8.2 Cuentas por pagar y pagos a proveedores
Funcionan igual que los cobros: **Pagos a proveedores → Nuevo**, con pagos parciales, otra moneda, compensación de saldos a favor (devoluciones) y anulación. El pago sale de una cuenta bancaria o caja **de la misma moneda del pago**; si la cuenta no tiene fondos (y no tiene sobregiro) el sistema rechaza el pago.

### 8.3 Bancos y cajas
- **Tesorería → Bancos y cajas**: saldo en libros, saldo conciliado y movimientos sin conciliar de cada cuenta.
- **Nuevo movimiento**: depósito, retiro, comisión o ajuste. **Transferencia** entre cuentas (si son de distinta moneda indique cuánto recibe la de destino).
- El libro es **inmutable**: no se editan ni borran movimientos; las anulaciones generan reversos.
- **Sobregiro**: cada cuenta tiene su límite (0 = no puede quedar en negativo). Los reversos y los movimientos que ya ocurrieron en el banco no se bloquean.

### 8.4 Conciliación bancaria
Entre al libro de una cuenta:
- **Manual**: marque los movimientos que aparecen en su extracto, pulse **Conciliar seleccionados** e indique fecha y saldo del extracto. Solo se guarda si el saldo **cuadra** con lo conciliado.
- **Con archivo**: **Importar extracto** (.xlsx o .csv con fecha, referencia, descripción y monto —o columnas débito/crédito—). **Validar y emparejar** propone las parejas por monto exacto y fecha (tolerancia en días) y muestra lo que no tiene pareja. **Aplicar y conciliar** puede además registrar las líneas sin pareja (comisiones, intereses) y concilia todo si el saldo final cuadra; si no, **no se guarda nada**.

### 8.5 Diferencial cambiario
Cuando se paga o cobra un documento en moneda extranjera a una tasa distinta de la de su registro, el sistema guarda la ganancia o pérdida en Bs. Consúltela en **Reportes → Fiscal → Diferencial cambiario realizado**.

## 9. Panel y alertas

El **Panel** muestra contadores (productos, clientes, valor del inventario, órdenes y pedidos abiertos) y **alertas** según sus permisos: existencias bajo el mínimo, lotes vencidos o por vencer (30 días), cuentas por pagar y por cobrar vencidas, cuentas por pagar que vencen en 7 días, cotizaciones por vencer y movimientos bancarios con más de 30 días sin conciliar. Cada alerta lleva al reporte correspondiente.

## 10. Fiscal

### 10.1 Qué calcula el sistema
- **IVA** por línea según el impuesto del producto (queda congelado en el documento). Las líneas exentas o exoneradas se totalizan aparte.
- **IGTF** sobre pagos en divisas (facturas de contado y cobros posteriores), solo si la empresa es agente de percepción y el instrumento lo aplica.
- **Totales en moneda extranjera y en Bs** a la tasa del documento.

### 10.2 Retenciones de IVA e ISLR (menú **Fiscal → Retenciones**)
- **Practicadas a proveedores**: solo si la empresa es agente de retención de IVA. Elija el proveedor y la compra; el IVA retenido es el **% del proveedor × IVA de la compra** (puede cambiar el % y la base). Para ISLR indique el porcentaje y el concepto. Reduce la cuenta por pagar y genera el **comprobante en PDF** (numeración `RIVA-`/`RISLR-`).
- **Recibidas de clientes**: registre el número del comprobante del cliente y el porcentaje; reduce la cuenta por cobrar.
- Una retención por documento y tipo; se puede **anular** (restituye el saldo) y rehacer.
- Atajo: en la compra o la factura aparece el botón **Registrar retención**.

### 10.3 Libros y resúmenes (**Reportes → Ventas / Compras / Fiscal**)
**Libro de ventas** (facturas, notas de débito y de crédito, con anuladas), **Libro de compras** (con IVA retenido), **Resumen de IVA por mes** (débito, crédito, retenciones y cuota), **Retenciones practicadas/recibidas**, **IGTF cobrado** y **Diferencial cambiario**. Son **referenciales**: no generan los archivos para el SENIAT.

## 11. Importación de datos (**Configuración → Importar datos**)

Elija el tipo, **descargue la plantilla** (Excel o CSV), llénela y súbala.
1. **Validar archivo**: revisa fila por fila y muestra los errores sin guardar nada.
2. **Importar**: si todo es válido, guarda **todo o nada**.

Tipos: instancias, productos (con códigos de barras, OEM y precio), proveedores, clientes, **existencias iniciales** (crea y confirma un cargo por depósito; admite lotes, vencimientos y seriales), **precios por lista**, **saldos iniciales de cuentas por cobrar** y **por pagar** (monto negativo = saldo a favor; si la moneda no es Bs hay que indicar la tasa). Hasta 5 000 filas por archivo; acepta coma o punto decimal. Un producto existente se **omite** o se **actualiza** según la opción elegida.

## 12. Reportes y exportaciones

- **Reportes** agrupa los informes por categoría (Inventario, Instancias, Proveedores, Compras, Clientes, Vendedores, Ventas, Fiscal). Cada uno tiene filtros, se consulta en pantalla y se **exporta a PDF, Excel o CSV** (cada exportación queda registrada).
- **Reportes pesados**: use **«En segundo plano…»** (Excel, CSV o PDF) para no esperar; el archivo se genera aparte y aparece en **Reportes → Mis exportaciones** cuando está **Listo**, donde se descarga. Los archivos se conservan unos días. Hasta 300 000 filas (el PDF se limita a 5 000).

## 13. Administración y seguridad

- **Configuración → Usuarios**: crear usuarios de la empresa, asignar roles, activar/desactivar y restablecer contraseñas.
- **Configuración → Roles y permisos**: roles del sistema (no se borran) y roles propios con los permisos que elija. Los permisos tienen la forma *módulo:recurso:acción* (ver, crear, editar, confirmar, anular).
- **Configuración → Empresas** (solo administrador global): nombre, RIF, razón social, teléfono y correo. Los datos fiscales se completan después en Configuración → Empresa.
- **Configuración → Clientes** (solo administrador global): crea al administrador de cada empresa con nombre, correo, clave y la empresa a la que pertenece; también puede desactivarlo.
- **Configuración → Numeración**: prefijo, relleno y próximo número por tipo de documento (solo sube, para evitar duplicados). La numeración **no tiene huecos**.
- **Auditoría**: toda acción relevante queda registrada con usuario, fecha y detalle.

## 14. Limitaciones y validaciones pendientes

- Numeración de factura y control **provisional** (sin imprenta digital ni impresora fiscal todavía).
- **Anulación directa** de facturas (el contador debe indicar cuándo corresponde nota de crédito).
- **ISLR**: porcentaje y base se indican a mano (sin tabla de conceptos ni sustraendo).
- Los libros fiscales y el resumen de IVA son referenciales y no generan archivos de declaración.
- La conciliación con extracto empareja por **monto exacto** (no suma ni divide movimientos).
- El diferencial cambiario es informativo (el sistema no lleva contabilidad general).
- El **modo sin conexión/móvil** no forma parte de este sistema.

## 15. Preguntas frecuentes y mensajes comunes

| Mensaje | Qué significa / qué hacer |
|---|---|
| «No hay tasa de cambio para la moneda y fecha» | Cargue o sincronice la tasa del día en **Factor cambiario**. |
| «Stock insuficiente» | No hay existencia en ese depósito. Revise **Existencias** o cargue inventario. |
| «La existencia está reservada» | Hay pedidos o presupuestos que apartaron esas unidades; use otra cantidad o anule la reserva. |
| «Fondos insuficientes» | La cuenta no tiene saldo ni sobregiro. Deposite, use otra cuenta o configure el límite. |
| «Los pagos no cuadran con el total» | Los pagos de una factura de contado deben sumar **total + IGTF**. El mensaje indica el monto esperado. |
| «El pedido excede el límite de crédito» | El cliente supera su límite (pedidos + cuentas por cobrar). Cobre, suba el límite o pida autorización. |
| «Solo se pueden editar documentos en borrador» | Lo confirmado no se edita: anúlelo (con motivo) y cree otro, o use una nota. |
| «El período está cerrado» | Ese mes de inventario ya se cerró; reábralo o use una fecha de un período abierto. |
| Una opción del menú no aparece | Su rol no tiene el permiso; consúltelo con su administrador. |
| La sesión se cierra sola | La contraseña cambió, la cuenta se desactivó o pasaron varios días sin usar el sistema; vuelva a entrar. |

**Atajos de uso**: en las listas, la búsqueda filtra por número o nombre; en los documentos, «Guardar borrador» conserva sin afectar inventario ni cuentas; solo **Confirmar / Emitir** produce los efectos. Los totales de la pantalla se recalculan con la misma lógica del servidor, que es quien decide al guardar.

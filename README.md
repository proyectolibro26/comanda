# ta-ca — tu local, encendido

Software para bares y restaurantes — por Roman Web. (Antes "Comanda".)

- **QR por mesa**: el cliente pide, personaliza (sin tomate, extra queso), llama al mozo, pide la cuenta o paga con Mercado Pago.
- **Salón**: plano de mesas en vivo (libre, ocupada, pidió la cuenta, llama al mozo) y delivery en curso.
- **Mozo**: toma pedidos desde el celular viendo el stock en vivo.
- **Cocina y barra**: pantalla sin papel separada por estación, con semáforo de demora.
- **Caja**: descuento con tope por usuario, propina, pago dividido entre medios y vuelto.
- **Stock por receta y modificadores**: descuenta solo, marca agotado, pedido sugerido al proveedor por WhatsApp, compras y merma.
- **Carta y recetas**: ficha técnica, costo, margen y precio sugerido.
- **Clientes**: se arma solo con los pedidos de WhatsApp; el bot ofrece "lo de siempre".
- **Cierre y reportes**: ventas, caja, merma, mercadería vendida, stock restante, ventas por hora, ingeniería de menú y control de movimientos (auditoría).
- **Mostrador / para llevar**: pedido con nombre, pantalla de retiro para un televisor (`#pantalla`).
- **Reservas**: por día, con mesa asignada (se ve en el salón), choque de horarios, recordatorio para WhatsApp.
- **Impresión** (térmica 80 mm): comanda por estación, precuenta, ticket y cierre; impresión automática por equipo.
- **Reservas por WhatsApp**: el bot entiende día, hora y personas, controla que no esté lleno y deja cancelar.
- **Turnos de caja**: cada cajera abre su turno y lo cierra contando a ciegas; el dueño ve esperado, contado y faltante/sobrante por turno.
- **Roles**: el saldo de caja solo lo ve el dueño; la cajera hace el arqueo a ciegas.

PIN de prueba: Dueño `1234` · Cajera `0000` · Mozo `2222` · Cocina `1111`.

Sitio estático (`index.html`). En la demo los datos se guardan en el navegador; para uso real hace falta backend compartido, WhatsApp Business Cloud API, Mercado Pago y facturación ARCA.

## Nube (varios equipos en vivo)

- `supabase.sql`: crea la tabla y las funciones. Se pega en Supabase › SQL Editor y se corre.
- En `index.html`, `const NUBE={url,key}` lleva la URL del proyecto y la clave pública (anon).
- Cada local tiene un código. El dueño lo crea desde **QR y ajustes › Nube**; los demás equipos lo cargan en la entrada. Los QR de las mesas lo llevan adentro (`?l=código`).
- Los equipos del personal sincronizan el estado completo con control de versión y fusión de cambios (stock y numeración nunca se pisan). Sin internet siguen andando y sincronizan al volver.
- El celular del cliente nunca baja la caja, costos ni clientes: solo ve la carta, el stock y su mesa (`taca_carta`), y pide por `taca_cliente`, que descuenta stock y numera en el servidor.
- Para probar sin Supabase: abrir con `?mock=1` (servidor de prueba dentro del navegador).

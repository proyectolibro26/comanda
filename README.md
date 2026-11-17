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
- **Roles**: el saldo de caja solo lo ve el dueño; la cajera hace el arqueo a ciegas.

PIN de prueba: Dueño `1234` · Cajera `0000` · Mozo `2222` · Cocina `1111`.

Sitio estático (`index.html`). En la demo los datos se guardan en el navegador; para uso real hace falta backend compartido, WhatsApp Business Cloud API, Mercado Pago y facturación ARCA.

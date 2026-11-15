# Comanda

Demo de app para bares y restaurantes — por Roman Web.

- **QR por mesa** → el pedido va directo a cocina y la venta queda registrada en caja.
- **Cocina**: tablero Nuevos / En preparación / Listos (salón y delivery).
- **Stock por receta**: cada plato descuenta sus insumos; alertas de reposición y registro de merma.
- **Cierre del día**: ventas, saldo de caja, pendiente de cobro, mercadería vendida, merma, stock restante y ganancia bruta.
- **Roles con PIN**: el saldo de caja solo lo ve el dueño; la cajera hace el arqueo a ciegas.
- **WhatsApp**: asistente que toma pedidos de delivery y los manda a cocina (simulado en la demo).

PIN de prueba: Dueño `1234` · Cajera `0000` · Cocina `1111`.

Es un sitio estático (`index.html`). Los datos se guardan en el navegador (localStorage); para uso real hace falta backend compartido, WhatsApp Business Cloud API y Mercado Pago.

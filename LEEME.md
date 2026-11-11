# Entradas para la fiesta 🎉

Este proyecto incluye:

| Página | Para quién | Qué hace |
|---|---|---|
| `/` | Invitados | Eligen la entrada, cargan sus datos y pagan con **Mercado Pago** o **transferencia** |
| `/orden?id=...` | Invitados | Muestra sus **QR** (uno por entrada). Con transferencia, también sirve para subir el comprobante |
| `/scanner` | Tu gente en la puerta | Abre la cámara del celu, escanea el QR y muestra en pantalla completa **VÁLIDA** (verde), **YA USADA** (rojo, con la hora en que entró) o **NO VÁLIDA** |
| `/admin` | Vos | Aprobás o rechazás transferencias, ves lo recaudado, cuántas se vendieron en cada tanda y cuánta gente entró, creás invitaciones gratis y descargás la lista en CSV |

Cada QR se puede usar **una sola vez**. Aunque dos celulares escaneen el mismo QR al mismo tiempo, solo uno va a dar "VÁLIDA".

---

## 1. Configurá tu fiesta

Ya está cargado con los datos de Lemon Fest. En **`evento.json`** podés cambiar:

- `nombre`, `fecha`, `lugar`, `descripcion` (lugar y descripción están vacíos: si los completás aparecen debajo de la fecha)
- `tandas`: cada tanda tiene `desde` y `hasta` (año-mes-día, ambos días incluidos, hora Argentina) y su `precio` (en pesos, sin puntos). Hoy están así:

| Tanda | Fechas | Precio |
|---|---|---|
| 1ra tanda | 19/11 al 26/11 | $15.000 |
| 2da tanda | 27/11 al 03/12 | $17.500 |
| 3ra tanda | 04/12 al 11/12 | $20.000 |
| 4ta tanda | 12/12 al 16/12 | $22.500 |
| Última tanda | 17/12 al 18/12 | $25.000 |

  La página solo muestra la tanda vigente: el precio de las próximas **no aparece en ningún lado** (ni en la página ni en lo que manda el servidor) hasta que llega su fecha. Antes del 19/11 se ve una cuenta regresiva, y desde el 19/12 la venta online queda cerrada. El precio lo decide el servidor según la fecha, así que nadie puede comprar a un precio viejo tocando la página.
- `cupoTotal`: cantidad máxima de entradas a vender. Está en `null` (sin límite). Si querés un tope, poné un número, por ejemplo `400`.
- `maxPorCompra`: cuántas entradas puede comprar una persona de una vez
- `transferencia`: el alias ya está (`lemonfest2026`). Te conviene completar también `titular` (y `cbu`/`banco` si querés), así la gente ve a nombre de quién está la cuenta. Si no querés aceptar transferencias, poné `"habilitada": false`.
- `mercadopago.habilitado`: ponelo en `false` si no querés cobrar con MP.

## 2. Sacá tus credenciales de Mercado Pago

1. Entrá a <https://www.mercadopago.com.ar/developers/panel/app> con tu cuenta de MP y creá una aplicación (elegí "Pagos online" → "Checkout Pro").
2. Andá a **Credenciales de producción** y copiá el **Access Token** (empieza con `APP_USR-`).
3. Para probar antes sin plata real, usá las **credenciales de prueba** y las tarjetas de prueba de MP. Cuando esté todo bien, las cambiás por las de producción.

> ⚠️ El Access Token es secreto: no lo mandes por WhatsApp ni lo pegues en `evento.json`. Va solo en las variables de entorno de Render (paso 4).

## 3. Creá la base de datos gratis (Neon)

Render borra los archivos cada vez que reinicia, así que las entradas se guardan en una base de datos aparte:

1. Creá una cuenta en <https://neon.tech> (plan gratis).
2. Creá un proyecto y copiá el **connection string** (empieza con `postgresql://...`).

## 4. Subí el proyecto a Render

1. Subí esta carpeta a un repositorio de **GitHub** (podés arrastrar los archivos en github.com → "New repository" → "uploading an existing file").
2. En <https://render.com> → **New → Web Service** → conectá ese repositorio.
3. Configurá:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. En **Environment**, agregá estas variables:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | El connection string de Neon |
| `MP_ACCESS_TOKEN` | Tu Access Token de Mercado Pago |
| `BASE_URL` | La dirección que te da Render, por ejemplo `https://mi-fiesta.onrender.com` (sin `/` al final) |
| `ADMIN_PASSWORD` | Una contraseña fuerte para `/admin` |
| `STAFF_PIN` | Un PIN para los que escanean en la puerta (podés cambiarlo después de la fiesta) |
| `SESSION_SECRET` | Cualquier texto largo y random (por ejemplo, 40 letras y números al azar) |

5. Deploy. Cuando termine, entrá a tu dirección de Render y listo. Pasale a la gente el link de la página principal.

> 💡 El plan gratis de Render "se duerme" después de 15 minutos sin visitas y tarda ~1 minuto en despertar. Para el día de la fiesta te conviene pasarlo al plan **Starter** (USD 7/mes, lo das de baja después) así el escáner responde al instante. Los pagos de MP no se pierden aunque esté dormido: la página de la orden los vuelve a verificar sola.

## 5. El día de la fiesta

- Los de la puerta abren `https://tu-dirección/scanner` en el celu, ponen el PIN y aceptan el permiso de la cámara. Pueden escanear varios celulares a la vez.
- Si un QR no se lee (pantalla rota, brillo bajo), se puede escribir el código que aparece abajo del QR.
- Arriba del escáner se ve cuánta gente entró.
- Recomendado: pedir el DNI y comparar el nombre que aparece en pantalla verde.
- Tené a mano el **CSV** descargado desde `/admin` por si se corta internet.

## Probarlo en tu compu (opcional)

Necesitás Node.js 22.13 o más nuevo.

```bash
npm install
npm start
```

Abrí <http://localhost:3000>. Sin `DATABASE_URL` usa un archivo local `data.sqlite`. Contraseña de admin por defecto: `admin123`, PIN por defecto: `1234` (cambialos con las variables de entorno). Mercado Pago queda apagado si no ponés `MP_ACCESS_TOKEN`. La cámara del escáner solo funciona en `localhost` o en `https`.

## Cómo funciona por dentro (por si te interesa)

- **Mercado Pago:** se crea un pago de Checkout Pro con el número de orden. Cuando MP avisa (webhook en `/webhook/mp`) o cuando la persona vuelve a la página de su orden, el servidor **le pregunta directamente a MP** si el pago está aprobado y si el monto es correcto. Recién ahí genera los QR. No se puede falsificar el aviso.
- **Transferencia:** la orden queda pendiente hasta que vos la aprobás en `/admin` mirando el comprobante.
- **QR:** cada uno lleva un código al azar imposible de adivinar (`TK-...`). Al escanear, el servidor lo marca como usado en una sola operación atómica.
- **Cupo:** las órdenes pendientes reservan lugar un rato (30 min con MP, 3 h con transferencia sin comprobante) para que no se vendan más entradas que el cupo.

# Notas

App de notas para iPhone, **gratis y sin suscripciones**.

Es una *web app instalable* (PWA): se instala desde Safari en la pantalla de inicio,
abre a pantalla completa como cualquier app y **funciona sin internet**.
No hace falta pagar la cuenta de desarrollador de Apple (99 USD/año) ni pasar por la App Store.

## Qué hace

**Etapa 2 — Categorías y nota rápida por voz**

- **Categorías con color** (vienen Negocio, Ideas, Proyectos y Personal; podés crear, renombrar o borrar).
  Se filtran tocando los chips de arriba de la lista.
- **Nota rápida por voz** (botón 🎤 abajo a la izquierda): dictás con el micrófono del teclado del iPhone,
  tocás *Listo* y la app **detecta la categoría** ("En el buffet tengo que comprar luces led" → *Buffet*)
  y te pregunta **"¿Guardar esta nota en Buffet?"** antes de guardarla. Te dice qué palabra reconoció
  y podés elegir otra categoría con un toque.
- **Palabras clave** por categoría (por ejemplo, para *Buffet*: cantina, kiosco) para que la reconozca aunque
  no digas el nombre.
- Cambiar la categoría de una nota desde el editor.
- Si creás una nota estando dentro de una categoría, queda en esa categoría.

> Si no ves el micrófono en el teclado: *Ajustes → General → Teclado → Activar Dictado*.

Más detalles de por qué se hizo así en [INVESTIGACION.md](INVESTIGACION.md).

**Etapa 1 — Lo básico**

- Crear, editar y eliminar notas (la primera línea es el título, como en Notas de Apple).
- Guardado automático mientras escribís.
- Buscador (no distingue mayúsculas ni acentos) con resaltado.
- Fijar notas arriba de todo.
- Deslizar una nota hacia la izquierda para **Fijar** o **Eliminar**, con opción de **Deshacer**.
- Notas agrupadas por fecha: Hoy, Ayer, Últimos 7 días, etc.
- Compartir una nota (WhatsApp, Mail, Mensajes…).
- Copia de seguridad: exportar / importar todas las notas en un archivo `.json`.
- Modo oscuro automático.
- Funciona sin conexión.

## Privacidad

Las notas se guardan **solo en tu iPhone** (en el almacenamiento de la app).
No se suben a ningún servidor, ni siquiera a GitHub: el repositorio solo tiene el código.

> Importante: si borrás la app de la pantalla de inicio, se borran sus notas.
> Usá **⋯ → Exportar copia de seguridad** de vez en cuando y guardá el archivo en Archivos / iCloud Drive.

## Cómo publicarla gratis

La app necesita estar en una dirección `https://` para poder instalarla.
La forma más simple y gratuita es **GitHub Pages**:

1. GitHub Pages es gratis en repositorios **públicos**. Si el repo es privado, cambialo a público en
   *Settings → General → Danger Zone → Change visibility*.
   (Tus notas no están en el repo, así que no se expone nada personal.)
2. Andá a *Settings → Pages*.
3. En **Source** elegí *Deploy from a branch*, rama `main`, carpeta `/ (root)` y tocá **Save**.
4. En uno o dos minutos la app queda en `https://<tu-usuario>.github.io/App-Notas/`.

Si preferís dejar el repo privado, podés usar **Cloudflare Pages** o **Netlify** (ambos con plan gratis):
conectás el repo, sin comando de compilación y con la carpeta raíz como salida.

## Cómo instalarla en el iPhone

1. Abrí la dirección de la app en **Safari** (tiene que ser Safari).
2. Tocá el botón **Compartir** (el cuadrado con la flecha hacia arriba).
3. Elegí **Agregar a pantalla de inicio** → **Agregar**.
4. Listo: abrila desde el ícono "Notas" de tu pantalla de inicio.

## Actualizaciones

Cuando se publiquen cambios, la app los descarga sola la próxima vez que la abras con internet
(y se aplican al abrirla una vez más). Tus notas no se tocan.

## Estructura del proyecto

| Archivo | Para qué sirve |
| --- | --- |
| `index.html` | Estructura de las pantallas |
| `styles.css` | Diseño (estilo iOS, claro/oscuro) |
| `app.js` | Lógica: notas, búsqueda, guardado, copias de seguridad |
| `sw.js` | Service worker: permite usarla sin internet |
| `manifest.webmanifest` | Nombre, ícono y modo pantalla completa |
| `icons/` | Íconos de la app |

Para probarla en la computadora: `python3 -m http.server` dentro de la carpeta y abrir `http://localhost:8000`.

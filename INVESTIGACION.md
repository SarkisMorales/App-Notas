# Investigación: qué hacen bien las mejores apps de notas

Fecha: octubre 2026. Objetivo: sacar ideas útiles para nuestra app (anotar ideas y proyectos rápido,
ordenados por categorías, y poder dictarlos con la voz).

## Lo que aprendimos de cada app

| App | Qué hace muy bien | Qué tomamos |
| --- | --- | --- |
| **Apple Notas** | Gratis, simple, todo el mundo la entiende. Carpetas + etiquetas + "carpetas inteligentes" (búsquedas guardadas que se actualizan solas). | Diseño estilo iOS, notas fijadas, la primera línea es el título. Las *carpetas inteligentes* quedan como idea a futuro. |
| **Google Keep** | Captura rapidísima, etiquetas de colores, filtro arriba de la lista. Se la recomienda como "bandeja de entrada" más que como archivo principal. | **Categorías con color** y **filtro de chips** arriba de la lista. |
| **Bear** | Etiquetas (#negocio) en vez de carpetas; etiquetas anidadas (#negocio/buffet). Una nota puede estar en varias. | Idea para más adelante: subcategorías (Negocio → Buffet). |
| **Drafts** | "**Primero capturar, después ordenar**": abre directo en una nota en blanco; todo cae en una bandeja de entrada que después se procesa. | **Nota rápida**: un toque y estás escribiendo/dictando; lo que no tiene categoría queda en "Sin categoría" para ordenarlo después. |
| **Voicenotes / Talknotes / Voxi** (apps de notas por voz con IA) | Un botón para grabar, transcripción y **categorización automática** según el contenido. Consejo de Voicenotes: usar siempre las mismas palabras clave al dictar para que clasifique mejor. | **Detección de categoría** por nombre y **palabras clave** configurables, con **confirmación** antes de guardar. |
| **Obsidian / Notion** | Potentes (enlaces entre notas, bases de datos), pero requieren tiempo para configurarlas. | Por ahora no: la prioridad es que sea rápida y simple. |

## Conclusiones

1. **La velocidad para anotar es lo más importante.** Si anotar cuesta, la idea se pierde.
2. **Ordenar no tiene que frenar la captura**: las categorías se sugieren solas y se confirman con un toque.
3. **Categorías visibles y con color** (estilo Keep) para encontrar todo rápido.
4. **Las palabras clave hacen que la clasificación automática funcione mejor.**

## ¿Se puede dictar por voz en nuestra app? (sin pagar)

- **Reconocimiento de voz de la web (Web Speech API):** funciona en Safari como página común, pero
  **Apple no lo habilita en las apps instaladas en la pantalla de inicio** (error de WebKit #225298,
  abierto desde 2021 y todavía sin solución).
- **Dictado del teclado del iPhone (🎤):** funciona en cualquier campo de texto, incluida nuestra app,
  es gratis y usa el reconocimiento de Apple. **Esta es la solución que usamos.**
  Si no aparece el micrófono: *Ajustes → General → Teclado → Activar Dictado*.
- **Grabar audio y transcribirlo con un servicio externo (OpenAI, Google, etc.):** funcionaría, pero
  cuesta plata por uso. Descartado.
- **Transcribir con un modelo dentro del teléfono (tipo Whisper en el navegador):** gratis, pero pesado
  (decenas de MB) y lento en el iPhone. Descartado por ahora.

## Fuentes

- https://www.ithinkdiff.com/best-note-taking-apps-iphone-2026/
- https://www.toolfinder.com/best/notes-apps-for-iphone
- https://support.apple.com/en-nz/102288 (etiquetas y carpetas inteligentes en Notas)
- https://blog.bear.app/2022/02/part-2-how-to-think-with-tags-create-a-habit-in-bear/
- https://docs.getdrafts.com/gettingstarted/
- https://thesweetsetup.com/quick-capture-with-drafts/
- https://voicenotes.com/blog/voice-memos
- https://voicenotes.com/blog/talknotes-vs-voicenotes
- https://bugs.webkit.org/show_bug.cgi?id=225298 (voz no disponible en apps de pantalla de inicio)
- https://whatpwacando.today/speech-recognition/

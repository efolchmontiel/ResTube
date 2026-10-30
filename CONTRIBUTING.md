# Contribuir a ResTube

Gracias por tu interés. ResTube acepta issues y PRs de cualquier persona; el propietario (@efolchmontiel) es el único que aprueba issues y hace el merge final.

## Camino rápido

1. **Abrí una issue** con el formulario correspondiente (error, mejora o pregunta). El formulario le pone etiquetas automáticamente: `status:triage` más su tipo (`type:bug`, `type:feature` o `type:question`).
2. **Esperá la aprobación del propietario**: solo @efolchmontiel puede poner la etiqueta `status:approved`. Una issue aprobada pierde `status:triage`.
3. **Abrí un PR que referencie la issue aprobada** con una forma explícita: `Refs #N`, `Closes #N`, `Fixes #N`, `Resolves #N` o la URL completa (`https://github.com/efolchmontiel/ResTube/issues/N`).
4. **Mirá el check «Issue approval gate»**: si todo está en orden queda en verde; si falta la issue, no está aprobada o la referencia no es válida, queda en rojo con el motivo y el **merge queda bloqueado**. El PR **no se cierra** por eso: puede corregirse y el check se recalcula solo.
5. **El propietario hace el merge final**: ninguna otra cuenta puede integrar cambios a `main`.

## Reglas del flujo

| Tema | Regla |
|---|---|
| Etiquetas de issues | Toda issue abierta lleva siempre etiquetas: si llega sin ninguna (por API, donde GitHub no puede exigir el formulario), un bot le restaura `status:triage`. |
| Aprobación | `status:approved` solo la puede poner el propietario. Si aparece puesta por otra cuenta, el bot la quita y vuelve a `status:triage`. |
| Referencias al PR | Se aceptan solo referencias explícitas a issues de este repositorio. Números sueltos (`#N` sin palabra clave), URLs de otros repos o números dentro de bloques de código no cuentan. |
| Múltiples issues | Si el PR referencia varias issues, **todas** deben estar aprobadas; si una no lo está, el merge queda bloqueado. |
| PRs de forks | El código de un PR de fork solo se ejecuta en el CI ordinario (`Test and build`), que es de solo lectura y sin secretos. |
| Comandos de prueba | `pnpm test`, `pnpm run typecheck` y `pnpm run build` (instalá antes con `pnpm install --frozen-lockfile`). |
| Secretos | Nunca incluyas credenciales, tokens ni archivos `.env` en issues, PRs ni código. |

## Detalle sobre la creación de issues y PRs

GitHub no permite rechazar en el momento la creación de una issue sin etiquetas o de un PR sin issue vinculada: cualquiera con una cuenta puede abrirlos por la API. Por eso la protección funciona en dos capas: un bot normaliza las etiquetas de las issues (restaura `status:triage`, quita aprobaciones falsificadas) y el check requerido «Issue approval gate» bloquea el merge de todo PR sin una issue aprobada por el propietario. Un PR sin issue aprobada puede existir, pero nunca puede fusionarse.

## Nota sobre la licencia

El repositorio todavía no tiene una licencia elegida; los términos de uso y de aceptación de contribuciones quedan a decisión del propietario.

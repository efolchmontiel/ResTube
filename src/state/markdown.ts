import type { SummaryResult } from '../data/summary';
/** Escape de texto ajeno también al exportar: enlaces/HTML/código no se vuelven instrucciones activas. */
import { displayTime } from '../data/summary';
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#!|])/g, '\\$1');
export function generateFullMarkdown({ video, model, summary: data }: SummaryResult): string {
  // Origen discriminado: un archivo local muestra su nombre, nunca una URL ni una ruta del servidor.
  const source = video.source === 'youtube' ? video.url : `Archivo local: ${video.title}`;
  let md = `# Resumen: ${escape(video.title)}\n\n- **Fuente del Video:** ${escape(source)}\n- **Autor:** ${escape(video.author)}\n- **Modelo:** ${escape(model.name)}\n\n`;
  md += '## Puntos Clave & Hallazgos\n\n';
  for (const item of data.takeaways) md += `### ${escape(item.num)}. ${escape(item.heading)} [${escape(displayTime(item.time))}]\n${escape(item.text)}\n\n`;
  md += `## Análisis en profundidad: ${escape(data.deepdive.heading)}\n\n${data.deepdive.paragraphs.map(escape).join('\n\n')}\n\n`;
  if (data.deepdive.code) md += data.deepdive.code.split('\n').map((line) => `    ${line}`).join('\n') + '\n\n';
  md += `## ${escape(data.actions.heading)}\n\n`;
  if (data.actions.items) md += data.actions.items.map((item) => `- ${escape(item)}`).join('\n') + '\n\n';
  if (data.actions.paragraph) md += `${escape(data.actions.paragraph)}\n\n`;
  md += '## Cita Destacada\n\n';
  md += data.quote ? `> ${escape(data.quote.text)}\n>\n> ${escape(data.quote.author)}\n` : 'No se incluyó una cita literal verificada.\n';
  return md;
}

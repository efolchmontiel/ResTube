import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import App from '../App';
import { installCatalogFetch } from './catalog';

it('elimina por completo la fuente de directos de YouTube', async () => {
  const mock = installCatalogFetch(); render(<App />);
  expect(screen.queryByRole('button', { name: /Directos de YouTube/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Conectar YouTube' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Programar resumen automático' })).not.toBeInTheDocument();
  expect(mock).toHaveBeenCalledTimes(1);
});

it.each([
  ['Enlace de YouTube', 'YouTube · Videos públicos finalizados con subtítulos en español o inglés. No se procesa audio.'],
  ['Archivo local', 'Archivo local · La transcripción ocurre en tu equipo (faster-whisper Base, sin conexión); el texto se envía al modelo elegido. Máximo 128 MiB y 2 horas.'],
])('no muestra la descripción auxiliar de %s', async (source, description) => {
  installCatalogFetch(); const user = userEvent.setup(); render(<App />);
  await user.click(screen.getByRole('button', { name: source }));
  expect(screen.queryByText(description)).not.toBeInTheDocument();
  expect(screen.getByLabelText(source === 'Archivo local' ? 'Archivo de video local' : 'URL del video')).toBeInTheDocument();
});

it('mantiene solo enlace de YouTube y archivo local como fuentes operativas', async () => {
  installCatalogFetch(); const user = userEvent.setup(); render(<App />);
  expect(screen.getAllByRole('button', { name: /Enlace de YouTube|Archivo local/ })).toHaveLength(2);
  expect(screen.getByLabelText('URL del video')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Archivo local' }));
  expect(screen.getByLabelText('Archivo de video local')).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Procesar archivo' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Enlace de YouTube' }));
  expect(screen.getByLabelText('URL del video')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Procesar Video/ })).toBeEnabled();
});

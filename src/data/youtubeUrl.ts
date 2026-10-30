/** Parseo cerrado compartido: devuelve solo identidad canónica, nunca la URL original. */
export function canonicalYoutube(input: string): { id: string; url: string } | null {
  try {
    if (input.length > 2048 || input !== input.trim() || /[\\\s]/.test(input)) return null;
    const u = new URL(input);
    if (!/^https:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//.test(input) || u.protocol !== 'https:' || u.username || u.password || u.port || input.split('/')[2].includes(':') || input.includes('#') || u.searchParams.has('list')) return null;
    let id: string | null = null;
    if (u.hostname === 'youtu.be') { if (/^\/[\w-]{11}$/.test(u.pathname)) id = u.pathname.slice(1); }
    else if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname)) {
      if (u.pathname === '/watch' && u.searchParams.getAll('v').length === 1) id = u.searchParams.get('v');
      else id = /^\/(?:shorts|embed|live)\/([\w-]{11})$/.exec(u.pathname)?.[1] ?? null;
    }
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    return { id, url: `https://www.youtube.com/watch?v=${id}` };
  } catch { return null; }
}

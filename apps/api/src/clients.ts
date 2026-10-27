/**
 * Serves the built client applications from the API process (single-host deployment).
 *
 *   /            the VHT app (a PWA; its service worker is scoped to the site root)
 *   /dashboard   the facility dashboard
 *
 * The API's own Content-Security-Policy forbids everything, which is right for JSON and
 * wrong for a page. Client responses get a policy of their own: same-origin only, with
 * each inline script allowed by its hash rather than by 'unsafe-inline'.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type Response } from 'express';

function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}'`,
  );
}

function policyFor(html: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(' ')}`.trim(),
    // Component libraries set style attributes at runtime.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function mount(app: Express, prefix: string, dir: string): boolean {
  const indexPath = join(dir, 'index.html');
  if (!existsSync(indexPath)) {
    console.warn(`[clients] ${dir} has no build; ${prefix} not served`);
    return false;
  }

  const index = readFileSync(indexPath, 'utf8');
  const csp = policyFor(index);

  const headers = (res: Response, path: string) => {
    res.setHeader('Content-Security-Policy', csp);
    // Hashed assets never change; the entry points must always be revalidated so a new
    // release (and a new service worker) reaches phones on their next visit.
    if (/[\\/]assets[\\/]/.test(path)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  };

  app.use(prefix, express.static(dir, { index: false, setHeaders: headers }));

  // Client-side routes: any other page navigation under the prefix gets the app shell.
  app.get(prefix === '/' ? '*' : `${prefix}*`, (req, res, next) => {
    if (!req.accepts('html') || req.path.startsWith('/api/')) return next();
    headers(res, indexPath);
    res.type('html').send(index);
  });
  return true;
}

export function serveClients(app: Express, dirs: { chwDir: string; dashboardDir: string }): void {
  // The dashboard first, so its routes are not swallowed by the VHT app's catch-all.
  if (mount(app, '/dashboard', dirs.dashboardDir)) console.log('[clients] dashboard at /dashboard');
  if (mount(app, '/', dirs.chwDir)) console.log('[clients] VHT app at /');
}

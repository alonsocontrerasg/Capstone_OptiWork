import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { envPublico, origenSupabase } from "@/lib/env";
import { OPCIONES_COOKIE, conOpcionesSeguras } from "@/lib/supabase/cookies";

/**
 * Proxy (antes `middleware.ts`, deprecado en Next 16).
 *
 * Hace dos cosas por request, en este orden:
 *
 * 1. **Refresca la sesión de Supabase** y reescribe las cookies en la respuesta. Sin esto,
 *    el access token caduca y el usuario aparece deslogueado a mitad de navegación (S-09).
 *    Las cookies se reescriben forzando `httpOnly`, `sameSite: 'lax'` y `secure` en
 *    producción (`OPCIONES_COOKIE`), porque `@supabase/ssr` las propone sin `httpOnly`.
 * 2. **Aplica la CSP con nonce** (S-10). El nonce se genera por request, se pone en la
 *    cabecera de *petición* (`Content-Security-Policy`) para que Next lo estampe en sus
 *    `<script>` inline, y se repite en la respuesta.
 *
 * No se hacen comprobaciones de autorización aquí: un guard en el proxy da una falsa
 * sensación de seguridad (se puede saltar en rutas no cubiertas) y la documentación de
 * Next desaconseja usarlo para eso. Los guards viven en `src/lib/auth/guards.ts`.
 */

const ES_DESARROLLO = process.env.NODE_ENV === "development";

function crearNonce(): string {
  return Buffer.from(globalThis.crypto.randomUUID()).toString("base64");
}

function construirCsp(nonce: string): string {
  const supabase = origenSupabase();

  // El navegador habla con Supabase por REST (https) y Realtime (wss). Se listan los dos
  // orígenes exactos: nada de comodines del tipo https://*.supabase.co.
  const conexiones = ["'self'"];
  if (supabase) conexiones.push(supabase.https, supabase.wss);
  if (ES_DESARROLLO) {
    // HMR de Next: websocket y recargas en localhost.
    conexiones.push("ws://localhost:*", "http://localhost:*");
  }

  const directivas: string[] = [
    "default-src 'self'",
    // 'strict-dynamic': los scripts cargados por un script con nonce heredan la confianza,
    // que es lo que necesita el runtime de Next. En dev hace falta 'unsafe-eval' (HMR).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${ES_DESARROLLO ? " 'unsafe-eval'" : ""}`,
    // En producción las hojas de estilo van por <link> ('self') y Next usa el nonce.
    // En desarrollo el overlay de errores inyecta <style> propios: relajar SOLO ahí.
    `style-src 'self' 'nonce-${nonce}'${ES_DESARROLLO ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src ${conexiones.join(" ")}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  if (!ES_DESARROLLO) {
    directivas.push("upgrade-insecure-requests");
  }

  return directivas.join("; ");
}

function aplicarCabecerasDeSeguridad(respuesta: NextResponse, csp: string): void {
  respuesta.headers.set("Content-Security-Policy", csp);
  respuesta.headers.set("X-Content-Type-Options", "nosniff");
  respuesta.headers.set("X-Frame-Options", "DENY");
  respuesta.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  respuesta.headers.set(
    "Permissions-Policy",
    "camera=(self), geolocation=(self), microphone=(), payment=()",
  );
  respuesta.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");

  if (!ES_DESARROLLO) {
    // Solo tiene sentido sobre HTTPS; Vercel sirve todo el dominio por HTTPS.
    respuesta.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains",
    );
  }
}

function serializarCookies(request: NextRequest): string {
  return request.cookies
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

export async function proxy(request: NextRequest) {
  const nonce = crearNonce();
  const csp = construirCsp(nonce);

  const cabecerasPeticion = new Headers(request.headers);
  cabecerasPeticion.set("x-nonce", nonce);
  cabecerasPeticion.set("Content-Security-Policy", csp);

  const siguiente = () =>
    NextResponse.next({ request: { headers: cabecerasPeticion } });

  let respuesta = siguiente();

  const supabase = createServerClient(
    envPublico.NEXT_PUBLIC_SUPABASE_URL,
    envPublico.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookieOptions: OPCIONES_COOKIE,
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesAEscribir, cabecerasDeCache) {
          // Se reflejan en la petición para que el render de ESTE request ya vea la sesión
          // renovada (el header `cookie` hay que rearmarlo a mano: mutar `request.cookies`
          // no reescribe los headers).
          for (const { name, value } of cookiesAEscribir) {
            request.cookies.set(name, value);
          }
          cabecerasPeticion.set("cookie", serializarCookies(request));

          respuesta = siguiente();
          for (const { name, value, options } of cookiesAEscribir) {
            respuesta.cookies.set(name, value, conOpcionesSeguras(options));
          }
          // Cabeceras anti-caché que exige @supabase/ssr cuando escribe cookies de sesión.
          for (const [nombre, valor] of Object.entries(cabecerasDeCache)) {
            respuesta.headers.set(nombre, valor);
          }
          aplicarCabecerasDeSeguridad(respuesta, csp);
        },
      },
    },
  );

  try {
    // Verifica el JWT y, si hace falta, lo refresca (escribe cookies vía setAll).
    await supabase.auth.getClaims();
  } catch {
    // Token inválido o red caída: se sigue como anónimo; cada página decide qué hacer.
  }

  aplicarCabecerasDeSeguridad(respuesta, csp);
  return respuesta;
}

export const config = {
  matcher: [
    {
      // Todo, salvo estáticos de Next, imágenes optimizadas y assets con extensión.
      source:
        "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|map|txt|xml|woff|woff2)$).*)",
      // Los prefetch no necesitan nonce ni refresh de sesión (guía de CSP de Next 16).
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

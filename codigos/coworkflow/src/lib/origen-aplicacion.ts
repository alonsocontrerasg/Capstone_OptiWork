import "server-only";
import { envPublico } from "@/lib/env";
import { resolverOrigenAplicacion } from "@/lib/auth/origen";

export function origenAplicacion(): string {
  return resolverOrigenAplicacion(envPublico.NEXT_PUBLIC_SITE_URL,
    process.env.VERCEL_ENV, process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL);
}

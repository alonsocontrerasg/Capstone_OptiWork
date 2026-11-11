/**
 * Reglas de contraseña compartidas entre el formulario (Client Component) y la validación
 * zod (servidor). Viven en `dominio` para no arrastrar zod al bundle del navegador.
 *
 * `PASSWORD_MIN_LENGTH` debe coincidir con el configurado en Supabase Auth (Auth →
 * Providers → Email → «Minimum password length»). Si Supabase exige más y zod acepta
 * menos, el error se ve como `weak_password` genérico; si zod exige más, se rechaza
 * localmente con un mensaje claro antes de llamar a Supabase.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

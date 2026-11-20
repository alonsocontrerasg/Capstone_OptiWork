import { expect, it } from "vitest";
import { resolverOrigenAplicacion } from "@/lib/auth/origen";
it("mantiene QR y correos en el dominio de la rama al probar el PR",()=>{
  expect(resolverOrigenAplicacion("https://produccion.example","preview","proyecto-git-rama.vercel.app")).toBe("https://proyecto-git-rama.vercel.app");
  expect(resolverOrigenAplicacion("https://produccion.example/","production","otro.vercel.app")).toBe("https://produccion.example");
  expect(()=>resolverOrigenAplicacion("https://produccion.example","preview","vercel.app.evil.example")).toThrow();
  expect(()=>resolverOrigenAplicacion("https://produccion.example","preview","usuario@proyecto.vercel.app")).toThrow();
});

import { expect } from "@playwright/test";

/** Mide el contenido real, sin ocultar desbordamientos con overflow-x:hidden. */
export async function medirResponsive(page) {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
    const caja = (e) => { const r=e.getBoundingClientRect();return { ancho:Math.round(r.width),alto:Math.round(r.height),x:Math.round(r.x),derecha:Math.round(r.right) }; };
    const texto = (e) => (e.getAttribute("aria-label") || e.innerText || e.name || e.tagName).trim().slice(0,80);
    const elementos = [...document.querySelectorAll("header *,main *,footer *")].filter(visible);
    const interactivos = [...document.querySelectorAll("header a,header button,main a,main button,main summary,footer a,input,select,textarea")]
      .filter(visible).filter((e)=>!e.disabled && e.type!=="hidden");
    return {
      viewport: document.querySelector('meta[name="viewport"]')?.content,
      pantalla: document.documentElement.clientWidth, documento: document.documentElement.scrollWidth,
      desbordamientos: elementos.filter((e)=>{const r=e.getBoundingClientRect();return r.right>document.documentElement.clientWidth+1||r.left < -1;})
        .map((e)=>({elemento:e.tagName,texto:texto(e),...caja(e)})).slice(0,20),
      scrollInterno: elementos.filter((e)=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+1&&["auto","scroll"].includes(getComputedStyle(e).overflowX))
        .map((e)=>({elemento:e.tagName,texto:texto(e),...caja(e)})),
      controlesPequenos: interactivos.map((e)=>{
        const objetivo = (e.type==="checkbox"||e.type==="radio") && e.labels?.length ? e.labels[0] : e;
        return {texto:texto(e),...caja(objetivo)};
      }).filter((e)=>e.ancho<44||e.alto<44),
      entradasPequenas: [...document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),select,textarea')]
        .filter(visible).filter((e)=>parseFloat(getComputedStyle(e).fontSize)<16).map((e)=>({texto:texto(e),fuente:getComputedStyle(e).fontSize})),
      textosPequenos: elementos.filter((e)=>["P","LABEL","H1","H2","H3","SUMMARY","TD","TH"].includes(e.tagName))
        .filter((e)=>parseFloat(getComputedStyle(e).fontSize)<14).map((e)=>({texto:texto(e),fuente:getComputedStyle(e).fontSize})).slice(0,30),
      textosCortados: elementos.filter((e)=>["P","H1","H2","H3","LABEL"].includes(e.tagName)&&getComputedStyle(e).textOverflow==="ellipsis"&&e.scrollWidth>e.clientWidth+1)
        .map((e)=>({texto:texto(e),...caja(e)})),
      medios: [...document.querySelectorAll('img,video,main [role="img"] svg')].filter(visible).map((e)=>({elemento:e.tagName,...caja(e)})),
    };
  });
}

export function comprobarResponsive(medida, nombre) {
  expect(medida.viewport,`${nombre}: viewport`).toContain("width=device-width");
  expect(medida.viewport,`${nombre}: zoom disponible`).not.toMatch(/user-scalable=no|maximum-scale=1(?:,|$)/);
  expect(medida.documento,`${nombre}: ancho del documento`).toBeLessThanOrEqual(medida.pantalla+1);
  expect(medida.entradasPequenas,`${nombre}: texto de formularios`).toEqual([]);
  expect(medida.textosPequenos,`${nombre}: texto legible`).toEqual([]);
  expect(medida.textosCortados,`${nombre}: texto cortado`).toEqual([]);
  expect(medida.controlesPequenos,`${nombre}: áreas táctiles`).toEqual([]);
  if(medida.pantalla<1024) {
    expect(medida.scrollInterno,`${nombre}: sin scroll lateral interno en móvil`).toEqual([]);
    expect(medida.desbordamientos,`${nombre}: elementos fuera de pantalla`).toEqual([]);
  }
}

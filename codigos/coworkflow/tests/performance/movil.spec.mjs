import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

// next start, caché fría, 1,6 Mb/s de bajada, 150 ms y CPU x4. Sin datos remotos.
if (!["localhost", "127.0.0.1"].includes(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname)) {
  throw new Error("Las mediciones solo consultan el Supabase local de pruebas");
}
for (const ruta of ["/", "/login", "/dashboard/estadisticas"]) {
  test(`rendimiento móvil ${ruta}`, async ({ page, context }, testInfo) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 150, downloadThroughput: 1600000 / 8, uploadThroughput: 750000 / 8,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.addInitScript(() => {
      window.__movil = { lcp: 0, cls: 0 };
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__movil.lcp = entry.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__movil.cls += entry.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto(ruta, { waitUntil: "load" });
    await expect(page.locator("main")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // Ventana de observación posterior a carga; no se espera networkidle por Realtime.
    await page.waitForTimeout(2000);
    const medida = await page.evaluate(() => {
      const recursos = performance.getEntriesByType("resource");
      const js = recursos.filter(r => r.initiatorType === "script" || /\.js(?:\?|$)/.test(r.name));
      return {
        ...window.__movil, ruta: location.pathname,
        jsBytesComprimidos: js.reduce((n, r) => n + r.encodedBodySize, 0),
        fuentes: recursos.filter(r => /\.woff2?(?:\?|$)/.test(r.name)).map(r => ({ nombre: new URL(r.name).pathname, bytes: r.encodedBodySize })),
        imagenesBytes: recursos.filter(r => r.initiatorType === "img").reduce((n,r) => n + r.encodedBodySize, 0),
        graficosIniciales: document.querySelectorAll(".recharts-surface").length,
        graficosY: document.querySelector('[data-testid="graficos-diferidos"]')?.getBoundingClientRect().y,
        altoViewport: innerHeight,
      };
    });
    await mkdir("test-results/rendimiento", { recursive: true });
    await writeFile(`test-results/rendimiento/${ruta.replaceAll("/", "-") || "inicio"}.json`, JSON.stringify(medida, null, 2));
    await testInfo.attach("medicion", { body: JSON.stringify(medida), contentType: "application/json" });
    expect(medida.lcp).toBeGreaterThan(0);
    // Presupuesto reproducible de transferencia; los tiempos se informan, no se confunden con datos de campo.
    expect(medida.jsBytesComprimidos).toBeLessThan(1024 * 1024);
    expect(medida.imagenesBytes).toBeLessThan(200 * 1024);
    if (ruta === "/dashboard/estadisticas") {
      if (medida.graficosY > medida.altoViewport + 200) expect(medida.graficosIniciales).toBe(0);
      await page.getByTestId("graficos-diferidos").scrollIntoViewIfNeeded();
      await expect(page.locator(".recharts-surface").first()).toBeVisible({ timeout: 30000 });
    }
  });
}

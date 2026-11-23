import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isConstrainedNetwork } from '../src/hooks/useAppGlobals';

const ROOT = path.resolve(__dirname, '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Matches static value imports (ignoring `import type ...`) from a given relative path fragment. */
function hasStaticValueImport(source: string, specifierFragment: string): boolean {
  const re = /(?:^|\n)\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(re)) {
    if (match[1].includes(specifierFragment)) return true;
  }
  return false;
}

describe('perfBundleAudit: cold-start code splitting boundaries', () => {
  it('FabricationModals keeps heavy modals and click-only handoffs off the static import graph', () => {
    const src = readSrc('src/components/FabricationModals.tsx');
    const lazyTargets = [
      'ExportLaserCutModal',
      'ExportContourSliceModal',
      'ExportReliefCarveModal',
      'ExportMoldModal',
      'ExportSolidMachiningModal',
      'ExportCastModal',
      'SplitForPrintModal',
      'TimberBreakdownModal',
      'ExportSheetUnfoldModal',
      'ExportTubeAndWireModal',
      'BrickworkModal',
      'MachineConfigModal',
      'etchSceneHandoff',
    ];
    for (const target of lazyTargets) {
      expect(hasStaticValueImport(src, target), `FabricationModals must not statically import ${target}`).toBe(false);
    }
    // Event listener shell must stay eager so deep-links (`?open=...`) never drop events.
    expect(src).toContain("window.addEventListener('physbox:open-fab', onOpenFab)");
    for (const modalKey of ['split', 'mold', 'unfold', 'unwrap', 'contour', 'relief', 'solid', 'joinery', 'pipes', 'brick']) {
      expect(src).toContain(`case '${modalKey}':`);
    }
    expect(src).toContain('<Suspense fallback={null}>');
  });

  it('ImportModals keeps all 6 import/generator modals lazy while keeping PCB handoff listener eager', () => {
    const src = readSrc('src/components/ImportModals.tsx');
    const lazyTargets = [
      'ImportStlModal',
      'ImportImageModal',
      'ImportProfileModal',
      'GeneratePatternModal',
      'MechanismBuilderModal',
      'ImportPcbModal',
    ];
    for (const target of lazyTargets) {
      expect(hasStaticValueImport(src, target), `ImportModals must not statically import ${target}`).toBe(false);
    }
    expect(src).toContain('usePcbHandoffLink()');
    expect(src).toContain('patternGeneratorId && <GeneratePatternModal />');
    expect(src).toContain('<Suspense fallback={null}>');
  });

  it('App.tsx lazy-loads on-demand panels, overlays, job modals, and the MCP bridge', () => {
    const src = readSrc('src/App.tsx');
    const lazyTargets = [
      'AICopilotPanel',
      'DocsModal',
      'SceneBrowser',
      'SavePresetModal',
      'ShareReportPortal',
      'WelcomeTourOverlay',
      'JobRestoreModal',
      'JobSucceededModal',
      'JobPauseModal',
      'ToolChangeModal',
      'useMCPBridge',
    ];
    for (const target of lazyTargets) {
      expect(hasStaticValueImport(src, target), `App.tsx must not statically import ${target}`).toBe(false);
    }
    // Tour replay and deep-link handling remain wired eagerly.
    expect(src).toContain('START_TOUR_EVENT');
    expect(src).toContain('parseMeshDeepLink');
    expect(src).toContain('restoreInterruptedJob');
  });

  it('useAppGlobals avoids static openscad import and respects constrained networks', () => {
    const src = readSrc('src/hooks/useAppGlobals.ts');
    expect(hasStaticValueImport(src, 'openscad')).toBe(false);
    expect(src).toContain("import('../utils/openscad')");

    expect(isConstrainedNetwork(undefined)).toBe(false);
    expect(isConstrainedNetwork({})).toBe(false);
    expect(isConstrainedNetwork({ connection: { saveData: false, effectiveType: '4g' } })).toBe(false);
    expect(isConstrainedNetwork({ connection: { saveData: true, effectiveType: '4g' } })).toBe(true);
    expect(isConstrainedNetwork({ connection: { effectiveType: '2g' } })).toBe(true);
    expect(isConstrainedNetwork({ connection: { effectiveType: 'slow-2g' } })).toBe(true);
  });

  it('vite.config.ts preserves worker ES format, WASM excludes, isolation headers, and $initial vendor groups', () => {
    const cfg = readSrc('vite.config.ts');
    expect(cfg).toContain("format: 'es'");
    expect(cfg).toContain("exclude: ['@mujoco/mujoco', '@lofcz/openscad-wasm']");
    expect(cfg).toContain("'Cross-Origin-Opener-Policy': 'same-origin'");
    expect(cfg).toContain("'Cross-Origin-Embedder-Policy': 'require-corp'");
    expect(cfg).toContain("fileName: 'version.json'");
    expect(cfg).toContain("tags: ['$initial']");
  });

  it('production dist/index.html (when built) does not eagerly preload lazy modals or MCP bridge', () => {
    const indexHtmlPath = path.join(ROOT, 'dist', 'index.html');
    if (!fs.existsSync(indexHtmlPath)) return;

    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    const preloaded = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
    expect(preloaded.length).toBeGreaterThan(0);

    const forbiddenEager = [
      'DocsModal',
      'AICopilotPanel',
      'SceneBrowser',
      'ExportLaserCutModal',
      'ExportContourSliceModal',
      'ExportReliefCarveModal',
      'ExportMoldModal',
      'ExportSolidMachiningModal',
      'ExportCastModal',
      'ExportSheetUnfoldModal',
      'ExportTubeAndWireModal',
      'SplitForPrintModal',
      'TimberBreakdownModal',
      'BrickworkModal',
      'MachineConfigModal',
      'ImportStlModal',
      'ImportImageModal',
      'ImportProfileModal',
      'ImportPcbModal',
      'GeneratePatternModal',
      'MechanismBuilderModal',
      'useMCPBridge',
    ];
    for (const name of forbiddenEager) {
      const hit = preloaded.find((f) => f.startsWith(`${name}-`));
      expect(hit, `dist/index.html must not eagerly preload ${name}`).toBeUndefined();
    }

    const versionPath = path.join(ROOT, 'dist', 'version.json');
    expect(fs.existsSync(versionPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(versionPath, 'utf8')) as { build?: string };
    expect(typeof parsed.build).toBe('string');
    expect(parsed.build!.length).toBeGreaterThan(0);
  });
});

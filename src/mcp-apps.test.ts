import { describe, it, expect } from 'vitest';
import { emitMcpApp } from './mcp-apps.ts';
import { P31_CATALOG } from './catalog.ts';
import goldSpecs from '../fixtures/gold-specs.json';

describe('emitMcpApp', () => {
  it('converts a gold tree into a renderable MCP Apps page', () => {
    const spec = (goldSpecs as any[])[0];
    const tree = spec.goldTree;
    const result = emitMcpApp(tree, P31_CATALOG);

    expect(result).toHaveProperty('html');
    expect(result).toHaveProperty('resourceUri');
    expect(result).toHaveProperty('csp');

    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('<html');
    expect(result.html).toContain('data-mcp-app="true"');

    // component markers + content
    expect(result.html).toContain('data-component="Card"');
    expect(result.html).toContain('data-component="StatCard"');
    expect(result.html).toContain('LOVE Balance');
    expect(result.html).toContain('42');

    // resource URI follows ui:// scheme
    expect(result.resourceUri).toMatch(/^ui:\/\/.+\.html$/);

    // deny-by-default CSP
    expect(result.csp.connectDomains).toEqual([]);
    expect(result.csp.resourceDomains).toEqual(["'unsafe-inline'"]);
    expect(result.csp.frameDomains).toEqual([]);
    expect(result.csp.baseUriDomains).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { emitA2UI, emitA2UIJsonl } from './a2ui.ts';
import { getCatalog } from './catalog.ts';

const catalog = getCatalog();

describe('A2UI v0.9 emitter', () => {
  it('emits createSurface + updateComponents for a simple tree', () => {
    const tree = {
      id: 'root',
      component: 'Card',
      props: { title: 'Hello' },
      children: [
        { id: 't1', component: 'Text', props: { content: 'World' }, children: [] },
      ],
    };
    const result = emitA2UI(tree, catalog);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.messages[0].createSurface).toBeDefined();
    expect(result.messages[0].createSurface?.surfaceId).toBe('main');
    expect(result.messages[1].updateComponents).toBeDefined();
    const comps = result.messages[1].updateComponents?.components ?? [];
    expect(comps.length).toBe(2);
    expect(comps.find(c => c.component === 'Card')).toBeDefined();
    expect(comps.find(c => c.component === 'Text')).toBeDefined();
  });

  it('children are referenced by id', () => {
    const tree = {
      id: 'root',
      component: 'Stack',
      props: { direction: 'vertical' },
      children: [
        { id: 'btn1', component: 'Button', props: { label: 'Click' }, children: [] },
      ],
    };
    const result = emitA2UI(tree, catalog);
    const comps = result.messages[1].updateComponents?.components ?? [];
    const stack = comps.find(c => c.component === 'Stack');
    expect(stack?.children).toContain('btn1');
  });

  it('emits JSONL', () => {
    const tree = { id: 'r', component: 'Text', props: { content: 'hi' }, children: [] };
    const result = emitA2UI(tree, catalog);
    const jsonl = emitA2UIJsonl(result);
    const lines = jsonl.split('\n');
    expect(lines.length).toBe(result.messages.length);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('extracts data bindings into data model', () => {
    const tree = {
      id: 'r',
      component: 'Text',
      props: { content: 'Hello {{user.name}}' },
      children: [],
    };
    const result = emitA2UI(tree, catalog);
    const dm = result.messages.find(m => m.updateDataModel);
    expect(dm).toBeDefined();
    expect(dm?.updateDataModel?.contents).toHaveProperty('user.name');
  });
});

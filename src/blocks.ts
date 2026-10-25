/**
 * @p31ca/genui — BlockNote-style block adapter
 */

export interface P31Block {
  id: string;
  type: string;
  component?: string;
  props: Record<string, unknown>;
  children: string[];
  content: unknown;
  hasId?: boolean;
  hasChildren?: boolean;
  hasProps?: boolean;
}

let _counter = 0;
function nextId(): string { return `b${++_counter}`; }
export function resetBlockCounter(): void { _counter = 0; }

function clone<T>(value: T): T {
  if (value === undefined) return value as T;
  try { return structuredClone(value); }
  catch { return JSON.parse(JSON.stringify(value)); }
}

function mapType(component: string): string {
  switch (component) {
    case 'Card': return 'heading';
    case 'Stack': return 'list';
    case 'Text': return 'paragraph';
    case 'Button': return 'paragraph';
    case 'Badge': return 'paragraph';
    case 'StatCard': return 'paragraph';
    case 'Alert': return 'quote';
    default: return 'paragraph';
  }
}

function toContent(node: any): unknown {
  const props = (node?.props && typeof node.props === 'object') ? node.props : {};
  let text = '';
  switch (node?.component) {
    case 'Text': text = typeof props.content === 'string' ? props.content : ''; break;
    case 'Button': text = typeof props.label === 'string' ? props.label : ''; break;
    case 'Badge': text = typeof props.label === 'string' ? props.label : ''; break;
    case 'StatCard': text = `${props.label ?? ''}: ${props.value ?? ''}`.trim(); break;
    case 'Alert': text = typeof props.message === 'string' ? props.message : ''; break;
    case 'Card': text = typeof props.title === 'string' ? props.title : ''; break;
    default: text = '';
  }
  return text ? [{ type: 'text', text }] : [];
}

interface ConvertResult { id: string | null; blocks: P31Block[]; }

function convert(node: any): ConvertResult {
  if (!node || typeof node !== 'object') return { id: null, blocks: [] };

  const hasId = typeof node.id === 'string';
  const id = hasId ? node.id : nextId();

  const hasChildren = Array.isArray(node.children);
  const childResults = hasChildren ? node.children.map((c: any) => convert(c)) : [];
  const childIds = childResults.map((r: ConvertResult) => r.id).filter((x: any) => typeof x === 'string');

  const hasProps = node.props !== undefined;
  const props = hasProps && typeof node.props === 'object' && node.props !== null
    ? clone(node.props) : {};

  const block: P31Block = {
    id,
    type: mapType(String(node.component ?? '')),
    component: typeof node.component === 'string' ? node.component : undefined,
    props,
    children: childIds,
    content: toContent(node),
    hasId,
    hasChildren,
    hasProps,
  };

  const blocks: P31Block[] = [block];
  for (const r of childResults) blocks.push(...r.blocks);
  return { id, blocks };
}

export function treeToBlocks(tree: any): P31Block[] {
  _counter = 0;
  if (!tree || typeof tree !== 'object') return [];
  const result = convert(tree).blocks;
  (result as any).blocks = result;
  return result;
}

function normalizeBlocks(input: any): P31Block[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object' && typeof input.id === 'string' && (typeof input.type === 'string' || typeof input.component === 'string')) {
    return [input];
  }
  if (input && typeof input === 'object') {
    if (Array.isArray(input.blocks)) return input.blocks;
    if (Array.isArray(input.value)) return input.value;
    if (Array.isArray(input.items)) return input.items;
  }
  return [];
}

export function blocksToTree(blocks: any): any {
  const list = normalizeBlocks(blocks);
  if (list.length === 0) return undefined;

  const byId = new Map<string, P31Block>();
  for (const b of list) if (b && typeof b.id === 'string') byId.set(b.id, b);

  const referenced = new Set<string>();
  for (const b of list) {
    if (Array.isArray(b?.children)) for (const c of b.children) if (typeof c === 'string') referenced.add(c);
  }
  const roots = list.filter((b: any) => b && typeof b.id === 'string' && !referenced.has(b.id));
  const rootBlocks = roots.length > 0 ? roots : [list[0]];

  const building = new Map<string, any>();
  function build(b: any): any {
    if (!b || typeof b !== 'object') return undefined;
    if (building.has(b.id)) return building.get(b.id);
    const node: any = {};
    if (typeof b.component === 'string') node.component = b.component;
    else if (typeof b.type === 'string') node.component = b.type;

    if (b.hasProps === false) {
      // preserve absent props
    } else if (b.props && typeof b.props === 'object') {
      node.props = clone(b.props);
    } else {
      node.props = {};
    }

    const hasChildren = b.hasChildren === true || (b.hasChildren === undefined && Array.isArray(b.children));
    if (!hasChildren) {
      // preserve absent
    } else if (Array.isArray(b.children)) {
      const childNodes: any[] = [];
      for (const cid of b.children) {
        const childBlock = byId.get(String(cid));
        if (childBlock) childNodes.push(build(childBlock));
        else childNodes.push({ component: 'Text', props: {}, children: [], id: cid });
      }
      node.children = childNodes;
    } else {
      node.children = [];
    }

    if (b.hasId === false) {
      // omit id
    } else if (b.hasId === true || (b.hasId === undefined && typeof b.id === 'string')) {
      node.id = b.id;
    }

    building.set(b.id, node);
    return node;
  }

  const builtRoots = rootBlocks.map((b: any) => build(b));
  return builtRoots.length === 1 ? builtRoots[0] : builtRoots;
}

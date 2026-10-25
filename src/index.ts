export * from './catalog.ts';
export * from './compile.ts';
export { repairLoop } from './repair.ts';
export type { RepairResult, RepairMetrics } from './repair.ts';
export * from './plan.ts';
export * from './schema.ts';
export * from './orchestrate.ts';
export * from './heal.ts';
export * from './capability.ts';
export * from './render.tsx';
export * from './ShellRenderer.tsx';
export * from './fidelity.ts';
export { refineUI, computeDiff } from './refine.ts';
export type { RefineInput, RefineOutput } from './refine.ts';
export * from './a11y.ts';
export * from './apr.ts';
export { resolveTemplates, applyBindings } from './binding.ts';
export type { BindingContext } from './binding.ts';
export * from './patch.ts';
// PARKED (2026-10-21, external review): the comprehension gate has never
// produced a live number and doubles the model-call cost per evaluation.
// The API stays exported for compatibility; the gate is NOT part of any
// evaluation path. See src/comprehension.ts for the unblock criteria.
export * from './comprehension.ts';
export * from './provider.ts';
export * from './mcp-apps.ts';
export * from './a2ui.ts';
export * from './blocks.ts';
export * from './DocEditor.tsx';
export * from './design-adapter.ts';
export * from './DesignCanvas.tsx';
export * from './offline.ts';

/**
 * @p31ca/genui — BlockNote editor surface for Docs artifact type
 * 
 * Renders a BlockNote editor from P31 compiled trees (via blocksToTree/treeToBlocks).
 * Supports block ops by blockId (insert/update/delete) and comment triggers.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { treeToBlocks, blocksToTree, type P31Block } from './blocks';
import '@blocknote/mantine/style.css';

export interface BlockOp {
  type: 'insert' | 'update' | 'delete';
  blockId: string;
  parentId?: string;
  index?: number;
  block?: Partial<P31Block>;
}

export interface BlockComment {
  id: string;
  blockId: string;
  text: string;
  author: string;
  resolved: boolean;
  createdAt: string;
}

export interface DocEditorProps {
  /** Compiled P31 tree to render */
  tree?: any;
  /** Initial blocks (alternative to tree) */
  blocks?: P31Block[];
  /** Callback when blocks change */
  onChange?: (blocks: P31Block[], tree: any) => void;
  /** Callback when a comment is added to a block */
  onBlockComment?: (comment: BlockComment) => void;
  /** Comments to display */
  comments?: BlockComment[];
  /** Whether editor is read-only */
  readOnly?: boolean;
  /** Apply block operations */
  applyOps?: BlockOp[];
}

/**
 * Convert P31 blocks to BlockNote format
 */
function p31ToBlockNote(blocks: P31Block[]): any[] {
  return blocks.map(block => {
    const blockType = block.type === 'heading' ? 'heading' : 
                      block.type === 'quote' ? 'quote' :
                      block.type === 'list' ? 'bulletListItem' : 'paragraph';
    
    return {
      id: block.id,
      type: blockType,
      props: {
        ...block.props,
      },
      content: Array.isArray(block.content) && block.content.length > 0
        ? block.content
        : block.component ? [{ type: 'text', text: block.component, styles: {} }] : [{ type: 'text', text: '', styles: {} }],
      children: [],
    };
  });
}

/**
 * Convert BlockNote format back to P31 blocks
 */
function blockNoteToP31(blockNoteBlocks: any[]): P31Block[] {
  const result: P31Block[] = [];
  
  function processBlock(b: any, parentId?: string) {
    const block: P31Block = {
      id: b.id,
      type: b.type === 'heading' ? 'heading' : b.type === 'quote' ? 'quote' : b.type === 'list' ? 'list' : 'paragraph',
      component: b.type === 'heading' ? 'Card' : b.type === 'quote' ? 'Alert' : b.type === 'list' ? 'Stack' : 'Text',
      props: b.props || {},
      children: [],
      content: b.content || [],
    };
    
    if (Array.isArray(b.children) && b.children.length > 0) {
      for (const child of b.children) {
        processBlock(child, b.id);
        block.children.push(child.id);
      }
    }
    
    result.push(block);
  }
  
  for (const b of blockNoteBlocks) {
    processBlock(b);
  }
  
  return result;
}

export const DocEditor: React.FC<DocEditorProps> = ({
  tree,
  blocks: initialBlocks,
  onChange,
  onBlockComment,
  comments = [],
  readOnly = false,
  applyOps = [],
}) => {
  const [blocks, setBlocks] = useState<P31Block[]>(() => {
    if (initialBlocks) return initialBlocks;
    if (tree) return treeToBlocks(tree);
    return [];
  });
  
  const [pendingOps, setPendingOps] = useState<BlockOp[]>([]);
  
  // Create BlockNote editor
  const editor = useCreateBlockNote({
    initialContent: blocks.length > 0 ? p31ToBlockNote(blocks) : undefined,
  });
  
  // Apply operations when they come in
  useEffect(() => {
    if (applyOps.length === 0) return;
    
    setBlocks(prevBlocks => {
      const newBlocks = [...prevBlocks];
      const blockMap = new Map(newBlocks.map(b => [b.id, b]));
      
      for (const op of applyOps) {
        if (op.type === 'delete') {
          const idx = newBlocks.findIndex(b => b.id === op.blockId);
          if (idx >= 0) {
            newBlocks.splice(idx, 1);
            blockMap.delete(op.blockId);
          }
        } else if (op.type === 'update') {
          const existing = blockMap.get(op.blockId);
          if (existing) {
            const idx = newBlocks.findIndex(b => b.id === op.blockId);
            if (idx >= 0) {
              newBlocks[idx] = { ...existing, ...op.block };
              blockMap.set(op.blockId, newBlocks[idx]);
            }
          }
        } else if (op.type === 'insert') {
          if (op.block) {
            const newBlock: P31Block = {
              id: op.blockId,
              type: op.block.type || 'paragraph',
              component: op.block.component,
              props: op.block.props || {},
              children: op.block.children || [],
              content: op.block.content || [],
            };
            if (op.parentId && blockMap.has(op.parentId)) {
              const parent = blockMap.get(op.parentId)!;
              const pIdx = newBlocks.findIndex(b => b.id === op.parentId);
              if (pIdx >= 0) {
                if (!Array.isArray(newBlocks[pIdx].children)) newBlocks[pIdx].children = [];
                if (typeof op.index === 'number') {
                  newBlocks[pIdx].children.splice(op.index, 0, op.blockId);
                } else {
                  newBlocks[pIdx].children.push(op.blockId);
                }
              }
            }
            if (typeof op.index === 'number' && !op.parentId) {
              newBlocks.splice(op.index, 0, newBlock);
            } else {
              newBlocks.push(newBlock);
            }
            blockMap.set(op.blockId, newBlock);
          }
        }
      }
      
      return newBlocks;
    });
  }, [applyOps]);
  
  // Handle editor changes
  const handleChange = useCallback(() => {
    if (readOnly) return;
    
    const bnBlocks = editor.document;
    const p31Blocks = blockNoteToP31(bnBlocks);
    setBlocks(p31Blocks);
    
    const tree = blocksToTree(p31Blocks);
    onChange?.(p31Blocks, tree);
  }, [editor, readOnly, onChange]);
  
  // Get comments for a block
  const getBlockComments = useCallback((blockId: string) => {
    return comments.filter(c => c.blockId === blockId && !c.resolved);
  }, [comments]);
  
  return (
    <div className="doc-editor" style={{ height: '100%', minHeight: '400px' }}>
      <BlockNoteView
        editor={editor}
        onChange={handleChange}
        editable={!readOnly}
        theme="light"
      />
      {comments.length > 0 && (
        <div className="doc-editor-comments" style={{ marginTop: '16px', padding: '16px', border: '1px solid #e0e0e0', borderRadius: '8px' }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600 }}>Comments</h3>
          {comments.filter(c => !c.resolved).map(comment => (
            <div key={comment.id} style={{ marginBottom: '12px', padding: '8px', background: '#f9f9f9', borderRadius: '4px' }}>
              <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>
                {comment.author} • {new Date(comment.createdAt).toLocaleString()}
              </div>
              <div style={{ fontSize: '13px' }}>{comment.text}</div>
              <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>
                Block: {comment.blockId}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default DocEditor;

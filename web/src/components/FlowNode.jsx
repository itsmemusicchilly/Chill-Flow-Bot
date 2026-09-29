import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { memo, useEffect } from 'react';
import { CATEGORIES, getOutputs, NODE_TYPES } from '@shared/catalog.js';
import { useEditor } from '../context.js';

function FlowNode({ id, type, data, selected }) {
  const def = NODE_TYPES[type];
  const { issuesByNode, flash, canRun, runNode } = useEditor();
  const updateNodeInternals = useUpdateNodeInternals();
  const outputs = def ? getOutputs(type, data) : [];
  const signature = outputs.map((o) => o.id).join('|');
  // handles come and go with buttons/menu options: tell React Flow to re-measure them
  useEffect(() => { updateNodeInternals(id); }, [id, signature, updateNodeInternals]);

  if (!def) return <div className="fnode unknown">Unknown node “{type}”</div>;
  const cat = CATEGORIES[def.category];
  const issues = issuesByNode[id] || [];
  const errors = issues.filter((i) => i.level === 'error');
  const summary = def.summary?.(data) ?? '';
  const classes = ['fnode', `cat-${def.category}`, selected ? 'selected' : '', flash[id] ? 'flash' : '', errors.length ? 'has-error' : issues.length ? 'has-warning' : ''].join(' ');
  const main = outputs.filter((o) => o.kind !== 'error');
  const error = outputs.find((o) => o.kind === 'error');

  return (
    <div className={classes} style={{ '--cat': cat.color }} data-testid={`node-${type}`}>
      {!def.isTrigger && <Handle type="target" position={Position.Left} id="in" className="h-in" style={{ top: 21 }} />}
      <div className="fnode-head">
        <span className="fnode-ico" aria-hidden="true">{def.icon}</span>
        <span className="fnode-title">{def.label}</span>
        {def.type === 'trigger.manual' && (
          <button className="run-btn nodrag" title={canRun ? 'Run this flow now' : 'Save and enable the flow first'} disabled={!canRun} onClick={(e) => { e.stopPropagation(); runNode(id); }}>▶ Run</button>
        )}
        {issues.length > 0 && (
          <span className={`badge ${errors.length ? 'bad' : 'warn'}`} title={issues.map((i) => i.message).join('\n')}>{errors.length ? '!' : '•'}</span>
        )}
      </div>
      {summary && <div className="fnode-body">{summary}</div>}
      <div className="fnode-outs">
        {main.map((o) => (
          <div key={o.id} className={`out ${o.kind || ''}`}>
            <span>{o.label}</span>
            <Handle type="source" position={Position.Right} id={o.id} className={`h-out ${o.kind || ''}`} />
          </div>
        ))}
        {error && (
          <div className="out error">
            <span>{error.label}</span>
            <Handle type="source" position={Position.Right} id={error.id} className="h-out error" />
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(FlowNode);

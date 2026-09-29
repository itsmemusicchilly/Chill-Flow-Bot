// Component custom ids carry everything needed to route a click, so buttons keep working after restarts.
// fc:<flowId>:<nodeId>:<handle>:<invokerId?>
export function buildCustomId({ flowId, nodeId, handle, invokerId = '' }) {
  const id = ['fc', flowId, nodeId, handle, invokerId].join(':');
  if (id.length > 100) throw new Error('Component id too long');
  return id;
}

export function parseCustomId(id) {
  const p = String(id).split(':');
  if (p[0] !== 'fc' || p.length < 4) return null;
  return { flowId: p[1], nodeId: p[2], handle: p[3], invokerId: p[4] || '' };
}

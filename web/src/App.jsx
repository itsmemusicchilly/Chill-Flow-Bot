import { useCallback, useEffect, useState } from 'react';
import { applyLimits } from '@shared/limits.js';
import { api, hashFor, logout, parseHash } from './api.js';
import Editor from './components/Editor.jsx';
import GuildPicker from './components/GuildPicker.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import Toasts from './components/Toasts.jsx';
import { ToastContext } from './context.js';

function useHashRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((guildId, flowId, pageId) => { window.location.hash = hashFor(guildId, flowId, pageId); }, []);
  return [route, navigate];
}

export default function App() {
  const [state, setState] = useState({ status: 'loading' });
  const [route, navigate] = useHashRoute();
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((message, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  const load = useCallback(async () => {
    try {
      const me = await api('/me');
      applyLimits(me.meta.limits); // the server's effective limits (null = unlimited)
      setState({ status: 'ready', me });
    } catch (e) {
      setState(e.status === 401 ? { status: 'anon' } : { status: 'error', error: e.message });
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onUnauthorized = () => setState({ status: 'anon' });
    window.addEventListener('fc:unauthorized', onUnauthorized);
    return () => window.removeEventListener('fc:unauthorized', onUnauthorized);
  }, []);

  const doLogout = async () => { await logout(); setState({ status: 'anon' }); navigate(null); };

  let body;
  if (state.status === 'loading') body = <div className="splash">Loading…</div>;
  else if (state.status === 'error') body = <div className="splash">Could not reach the server: {state.error} <button className="btn" onClick={load}>Retry</button></div>;
  else if (state.status === 'anon') body = <LoginScreen />;
  else {
    const { me } = state;
    const guild = route.guildId ? me.guilds.find((g) => g.id === route.guildId && g.botPresent) : null;
    body = guild
      ? <Editor key={guild.id} me={me} guild={guild} flowId={route.flowId} pageId={route.pageId} navigate={navigate} onLogout={doLogout} />
      : <GuildPicker me={me} onOpen={(g) => navigate(g.id)} onRefresh={load} onLogout={doLogout} />;
  }

  return (
    <ToastContext.Provider value={toast}>
      {body}
      <Toasts toasts={toasts} />
    </ToastContext.Provider>
  );
}

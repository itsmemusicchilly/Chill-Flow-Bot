import { createContext, useContext } from 'react';

/** Guild-level data + helpers shared by the inspector, fields and nodes. */
export const EditorContext = createContext({
  guildData: { channels: [], roles: [] },
  issuesByNode: {},
  flash: {},
  canRun: false,
  runNode: () => {},
});
export const useEditor = () => useContext(EditorContext);

export const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

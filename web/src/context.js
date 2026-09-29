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

/**
 * The server's uploaded pictures, for image fields anywhere in the editor.
 * `ids` is the set of picture ids once loaded (null before), `openLibrary({ onPick })` opens the picture library.
 */
export const ImagesContext = createContext({ gid: null, available: false, publicBase: false, ids: null, openLibrary: () => {} });
export const useImages = () => useContext(ImagesContext);

export const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

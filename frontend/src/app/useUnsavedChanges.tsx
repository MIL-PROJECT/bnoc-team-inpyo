import { createContext, useContext, useEffect, useId } from 'react';

export const UnsavedChangesContext = createContext<(id: string, dirty: boolean, blockLeaving?: boolean) => void>(() => {});
export function useUnsavedChanges(dirty: boolean, blockLeaving = false) {
  const register = useContext(UnsavedChangesContext), id = useId();
  useEffect(() => { register(id, dirty, blockLeaving); return () => register(id, false); }, [register, id, dirty, blockLeaving]);
}

import { useEffect, useState } from 'react';

/** Delay a rapidly-changing value — one query per pause, not per keystroke. */
export function useDebounced(value, delay = 200) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

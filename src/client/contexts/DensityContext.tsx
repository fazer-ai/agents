import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";

export type Density = "compact" | "comfortable";

// Keep in sync with the inline script in public/index.html, which applies
// the stored density before React loads so the first paint already has the
// right sizes. A derived project whose audience is not used to dense tools
// flips this (and the script's fallback) to "comfortable".
export const DEFAULT_DENSITY: Density = "compact";
export const DENSITY_STORAGE_KEY = "@app:density";

interface DensityContextType {
  density: Density;
  setDensity: (density: Density) => void;
}

const DensityContext = createContext<DensityContextType | null>(null);

function getStoredDensity(): Density {
  try {
    const stored = localStorage.getItem(DENSITY_STORAGE_KEY);
    if (stored === "compact" || stored === "comfortable") return stored;
  } catch {
    // NOTE: Ignore localStorage errors
  }
  return DEFAULT_DENSITY;
}

function applyDensity(density: Density) {
  document.documentElement.dataset.density = density;
}

export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensityState] = useState<Density>(() => {
    const initial = getStoredDensity();
    applyDensity(initial);
    return initial;
  });

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    applyDensity(next);
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      // NOTE: Ignore localStorage errors
    }
  }, []);

  return (
    <DensityContext.Provider value={{ density, setDensity }}>
      {children}
    </DensityContext.Provider>
  );
}

export function useDensity() {
  const context = useContext(DensityContext);
  if (!context) {
    throw new Error("useDensity must be used within a DensityProvider");
  }
  return context;
}

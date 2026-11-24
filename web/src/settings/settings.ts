// User settings, stored on this device only.

import { useCallback, useState } from 'react';
import { ALGORITHMS, type Algorithm, COLOR_MODES, type ColorMode, DEFAULT_ALGORITHM, DEFAULT_COLOR_MODE } from '../model';

export type OutputMode = 'next' | 'overwrite';

export type Settings = {
  /** Where results go: beside the source (default) or replacing it. */
  outputMode: OutputMode;
  /** Added to the source name for results written beside the source. */
  suffix: string;
  /** 60..100 */
  jpegQuality: number;
  /** Leave out files that already carry the suffix, so nothing is corrected twice. */
  skipProcessed: boolean;
  /** The correction method files start with when they are added. */
  defaultAlgorithm: Algorithm;
  /** The colour mode files start with when they are added. */
  defaultColorMode: ColorMode;
};

export const DEFAULT_SETTINGS: Settings = { outputMode: 'next', suffix: '_uwcc', jpegQuality: 92, skipProcessed: true, defaultAlgorithm: DEFAULT_ALGORITHM, defaultColorMode: DEFAULT_COLOR_MODE };

const KEY = 'uwcc-settings';

/** Keep the suffix safe for file names and never empty (an empty suffix would collide with the source). */
export function cleanSuffix(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\s.]+/g, '').slice(0, 24);
  return cleaned || DEFAULT_SETTINGS.suffix;
}

function sanitize(raw: Partial<Settings>): Settings {
  return {
    outputMode: raw.outputMode === 'overwrite' ? 'overwrite' : 'next',
    suffix: cleanSuffix(typeof raw.suffix === 'string' ? raw.suffix : DEFAULT_SETTINGS.suffix),
    jpegQuality: Math.min(100, Math.max(60, Math.round(Number(raw.jpegQuality) || DEFAULT_SETTINGS.jpegQuality))),
    skipProcessed: raw.skipProcessed !== false,
    defaultAlgorithm: ALGORITHMS.find((a) => a.id === raw.defaultAlgorithm)?.id ?? DEFAULT_ALGORITHM,
    defaultColorMode: COLOR_MODES.find((m) => m.id === raw.defaultColorMode)?.id ?? DEFAULT_COLOR_MODE,
  };
}

export function loadSettings(): Settings {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings(): [Settings, (next: Settings) => void] {
  const [settings, setSettings] = useState(loadSettings);
  const update = useCallback((next: Settings) => {
    const clean = sanitize(next);
    setSettings(clean);
    try {
      localStorage.setItem(KEY, JSON.stringify(clean));
    } catch {
      // Storage unavailable (private mode): the setting still applies for this session.
    }
  }, []);
  return [settings, update];
}

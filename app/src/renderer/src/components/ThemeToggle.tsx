import { setTheme, useTheme } from '../lib/theme.js';

/** Sun/moon toggle in the titlebar. Click flips between light and
 *  dark; preference is persisted in localStorage by the theme module. */
export function ThemeToggle(): JSX.Element {
  const theme = useTheme();
  const next: 'light' | 'dark' = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(next)}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
